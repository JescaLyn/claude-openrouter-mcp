/**
 * Input-validation tests for generate_docstring.
 */

import { describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/generate_docstring.js';
import type { ToolContext } from '../src/types.js';

function stubCtx() {
  const chain = vi.fn().mockResolvedValue({
    ok: true,
    content: '/** docstring */',
    model_used: 'free/primary',
    tokens_in: 10,
    tokens_out: 5,
    finish_reason: 'stop',
    fallback_chain: ['free/primary'],
    cost_usd: 0,
  });
  return {
    ctx: { client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'] },
    chain,
  };
}

function envelope(out: { content: Array<{ text: string }> }) {
  return JSON.parse(out.content[0]!.text);
}

describe('generate_docstring handler', () => {
  it('rejects missing language', async () => {
    const { ctx } = stubCtx();
    const out = await handler({ code: 'def f(): pass' }, ctx);
    expect(envelope(out).error.code).toBe('INVALID_INPUT');
  });

  it('rejects missing code', async () => {
    const { ctx } = stubCtx();
    const out = await handler({ language: 'python' }, ctx);
    expect(envelope(out).error.code).toBe('INVALID_INPUT');
  });

  it('rejects an out-of-enum style', async () => {
    const { ctx } = stubCtx();
    const out = await handler(
      { code: 'def f(): pass', language: 'python', style: 'haiku' },
      ctx,
    );
    expect(envelope(out).error.code).toBe('INVALID_INPUT');
  });

  it('surfaces upstream error from chatChain as-is', async () => {
    const errorChain = vi.fn().mockResolvedValue({
      ok: false,
      envelope: { error: { code: 'UPSTREAM_HTTP', message: 'upstream failed', retryable: true } },
      fallback_chain: ['free/primary'],
    });
    const errCtx = { client: { chatChain: errorChain, chatDirect: vi.fn() } as unknown as ToolContext['client'] };
    const out = await handler({ code: 'def f(): pass', language: 'python' }, errCtx);
    expect(envelope(out).error.code).toBe('UPSTREAM_HTTP');
  });

  it('returns success with valid args', async () => {
    const { ctx } = stubCtx();
    const out = await handler(
      { code: 'def f(): pass', language: 'python' },
      ctx,
    );
    const env = envelope(out);
    expect(env.result).toBe('/** docstring */');
  });
});
