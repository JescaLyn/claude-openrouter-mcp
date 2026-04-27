/**
 * Input-validation tests for query_long_context.
 */

import { describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/query_long_context.js';
import type { ToolContext } from '../src/types.js';

function stubCtx(): ToolContext {
  return {
    client: {
      chatChain: vi.fn().mockResolvedValue({
        ok: true,
        content: 'long-context answer',
        model_used: 'qwen/qwen3-next-80b-a3b-instruct',
        tokens_in: 120_000,
        tokens_out: 200,
        finish_reason: 'stop',
        fallback_chain: ['qwen/qwen3-next-80b-a3b-instruct'],
        cost_usd: 0,
      }),
      chatDirect: vi.fn().mockResolvedValue({
        ok: true,
        content: 'direct answer',
        model_used: 'custom/long-model',
        tokens_in: 1,
        tokens_out: 1,
        finish_reason: 'stop',
        fallback_chain: ['custom/long-model'],
        cost_usd: 0,
      }),
    } as unknown as ToolContext['client'],
  };
}

function envelope(out: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(out.content[0]!.text);
}

describe('query_long_context handler', () => {
  it('rejects missing prompt with INVALID_INPUT', async () => {
    const env = envelope(await handler({}, stubCtx()));
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects empty prompt with INVALID_INPUT', async () => {
    const env = envelope(await handler({ prompt: '' }, stubCtx()));
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('routes through long_context chain by default', async () => {
    const ctx = stubCtx();
    const env = envelope(await handler({ prompt: 'a very large prompt' }, ctx));
    expect(env.result).toBe('long-context answer');
    expect(env.model_used).toBe('qwen/qwen3-next-80b-a3b-instruct');
    expect(ctx.client.chatChain).toHaveBeenCalledTimes(1);
    expect(ctx.client.chatDirect).not.toHaveBeenCalled();
  });

  it('uses chatDirect when an explicit model override is provided', async () => {
    const ctx = stubCtx();
    const env = envelope(
      await handler({ prompt: 'big input', model: 'custom/long-model' }, ctx),
    );
    expect(env.result).toBe('direct answer');
    expect(env.model_used).toBe('custom/long-model');
    expect(ctx.client.chatDirect).toHaveBeenCalledTimes(1);
    expect(ctx.client.chatChain).not.toHaveBeenCalled();
  });
});
