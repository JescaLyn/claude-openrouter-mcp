/**
 * Tests for generate_regex.
 *
 * Includes:
 *   - Input-validation tests
 *   - The validatePattern unit test (validation rejects a non-matching pattern)
 *   - Retry behavior: first attempt fails validation, second attempt succeeds
 */

import { describe, expect, it, vi } from 'vitest';

import { handler, validatePattern } from '../src/tools/generate_regex.js';
import type { ToolContext } from '../src/types.js';

function envelope(out: { content: Array<{ text: string }> }) {
  return JSON.parse(out.content[0]!.text);
}

function stubChain(...contents: string[]) {
  const fn = vi.fn();
  for (const c of contents) {
    fn.mockResolvedValueOnce({
      ok: true,
      content: c,
      model_used: 'free/primary',
      tokens_in: 10,
      tokens_out: 5,
      finish_reason: 'stop',
      fallback_chain: ['free/primary'],
      cost_usd: 0,
    });
  }
  return fn;
}

describe('validatePattern', () => {
  it('passes when pattern matches all positives and rejects all negatives', () => {
    const v = validatePattern('^foo$', ['foo'], ['bar', 'foobar']);
    expect(v.positive_passed).toEqual([true]);
    expect(v.negative_passed).toEqual([true, true]);
  });

  it('rejects a non-matching pattern (validation surfaces the failure)', () => {
    // Pattern only matches "foo" — but positive example is "bar".
    const v = validatePattern('^foo$', ['bar'], ['baz']);
    expect(v.positive_passed).toEqual([false]);
    // Negative "baz" doesn't match the foo pattern, so negative passed.
    expect(v.negative_passed).toEqual([true]);
  });

  it('flags negatives that incorrectly match', () => {
    const v = validatePattern('foo', [], ['foo', 'bar']);
    expect(v.negative_passed).toEqual([false, true]);
  });

  it('throws on a malformed pattern', () => {
    expect(() => validatePattern('(unclosed', ['x'], [])).toThrow();
  });
});

describe('generate_regex handler — input validation', () => {
  function stubCtx() {
    return {
      client: {
        chatChain: vi.fn(),
        chatDirect: vi.fn(),
      } as unknown as ToolContext['client'],
    };
  }

  it('rejects missing description', async () => {
    const out = await handler({ positive_examples: ['foo'] }, stubCtx());
    expect(envelope(out).error.code).toBe('INVALID_INPUT');
  });

  it('rejects empty positive_examples', async () => {
    const out = await handler({ description: 'match foo', positive_examples: [] }, stubCtx());
    expect(envelope(out).error.code).toBe('INVALID_INPUT');
  });

  it('rejects an out-of-enum flavor', async () => {
    const out = await handler(
      { description: 'match foo', positive_examples: ['foo'], flavor: 'sed' },
      stubCtx(),
    );
    expect(envelope(out).error.code).toBe('INVALID_INPUT');
  });
});

describe('generate_regex handler — retry behavior', () => {
  it('returns success on first attempt when pattern validates', async () => {
    const chatChain = stubChain('^foo$');
    const ctx: ToolContext = {
      client: { chatChain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    const out = await handler(
      { description: 'match foo', positive_examples: ['foo'], negative_examples: ['bar'] },
      ctx,
    );
    const env = envelope(out);
    expect(env.result.pattern).toBe('^foo$');
    expect(env.result.flavor).toBe('js');
    expect(env.result.validation.positive_passed).toEqual([true]);
    expect(env.result.validation.negative_passed).toEqual([true]);
    expect(chatChain).toHaveBeenCalledTimes(1);
  });

  it('retries once when first pattern fails, succeeds on second', async () => {
    // First attempt: pattern that doesn't match the positive "foo".
    // Second attempt: correct pattern.
    const chatChain = stubChain('^bar$', '^foo$');
    const ctx: ToolContext = {
      client: { chatChain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    const out = await handler(
      { description: 'match foo', positive_examples: ['foo'] },
      ctx,
    );
    const env = envelope(out);
    expect(env.result.pattern).toBe('^foo$');
    expect(chatChain).toHaveBeenCalledTimes(2);
  });

  it('returns INVALID_INPUT after second attempt also fails', async () => {
    const chatChain = stubChain('^bar$', '^baz$');
    const ctx: ToolContext = {
      client: { chatChain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    const out = await handler(
      { description: 'match foo', positive_examples: ['foo'] },
      ctx,
    );
    const env = envelope(out);
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(env.error.message).toContain('Failed positives');
    expect(chatChain).toHaveBeenCalledTimes(2);
  });

  it('strips code fences and slash delimiters from the model output', async () => {
    const chatChain = stubChain('```regex\n^foo$\n```');
    const ctx: ToolContext = {
      client: { chatChain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    const out = await handler(
      { description: 'match foo', positive_examples: ['foo'] },
      ctx,
    );
    const env = envelope(out);
    expect(env.result.pattern).toBe('^foo$');
  });
});
