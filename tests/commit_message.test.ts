/**
 * Input-validation tests for commit_message.
 */

import { describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/commit_message.js';
import type { ToolContext } from '../src/types.js';

function stubCtx() {
  const chain = vi.fn().mockResolvedValue({
    ok: true,
    content: 'Added commit message tool.',
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

describe('commit_message handler', () => {
  it('rejects missing diff', async () => {
    const { ctx } = stubCtx();
    const out = await handler({}, ctx);
    expect(envelope(out).error.code).toBe('INVALID_INPUT');
  });

  it('rejects empty diff', async () => {
    const { ctx } = stubCtx();
    const out = await handler({ diff: '' }, ctx);
    expect(envelope(out).error.code).toBe('INVALID_INPUT');
  });

  it('returns success with a valid diff', async () => {
    const { ctx } = stubCtx();
    const out = await handler(
      { diff: 'diff --git a/foo b/foo\n+hello' },
      ctx,
    );
    const env = envelope(out);
    expect(env.result).toBe('Added commit message tool.');
  });

  it('threads scope_hint into the user message', async () => {
    const { ctx, chain } = stubCtx();
    await handler(
      { diff: 'diff --git a/foo b/foo\n+hello', scope_hint: 'auth module' },
      ctx,
    );
    const callArgs = chain.mock.calls[0]?.[0];
    const userMsg = callArgs.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMsg.content).toContain('Scope hint: auth module');
  });

  it('appends custom instructions to the default system prompt when provided', async () => {
    const { ctx, chain } = stubCtx();
    await handler(
      { diff: 'diff --git a/foo b/foo\n+hello', instructions: 'Custom style rules.' },
      ctx,
    );
    const callArgs = chain.mock.calls[0]?.[0];
    const sysMsg = callArgs.messages.find((m: { role: string }) => m.role === 'system');
    expect(sysMsg.content).toContain('Write a single-line git commit message');
    expect(sysMsg.content).toContain('Custom style rules.');
  });
});
