/**
 * Input-validation tests for explain_code.
 *
 * The handler is exercised with a stub client so we don't go to the network.
 * These focus on argument shape; client-level behavior is covered in client.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/explain_code.js';
import type { ToolContext } from '../src/types.js';

function stubCtx(): ToolContext {
  return {
    client: {
      chatChain: vi.fn().mockResolvedValue({
        ok: true,
        content: 'explanation text',
        model_used: 'free/primary',
        tokens_in: 10,
        tokens_out: 5,
        finish_reason: 'stop',
        fallback_chain: ['free/primary'],
        cost_usd: 0,
      }),
      chatDirect: vi.fn(),
    } as unknown as ToolContext['client'],
  };
}

function envelope(out: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(out.content[0]!.text);
}

describe('explain_code handler', () => {
  it('rejects missing code with INVALID_INPUT', async () => {
    const out = await handler({}, stubCtx());
    const env = envelope(out);
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects empty code with INVALID_INPUT', async () => {
    const out = await handler({ code: '' }, stubCtx());
    const env = envelope(out);
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects an out-of-enum focus value', async () => {
    const out = await handler({ code: 'x', focus: 'cosmic' }, stubCtx());
    const env = envelope(out);
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('passes valid args through to the client and returns success', async () => {
    const ctx = stubCtx();
    const out = await handler({ code: 'function f(){}', focus: 'security' }, ctx);
    const env = envelope(out);
    expect(env.result).toBe('explanation text');
    expect(env.model_used).toBe('free/primary');
  });
});
