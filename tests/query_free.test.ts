/**
 * query_free tests — focused on:
 *   - Input validation
 *   - Routes through chatChain by default (task_type → chain)
 *   - Model override routes through chatDirect
 *   - System prompt threaded through composeMessages
 *   - Upstream error surfaced directly
 */

import { describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/query_free.js';
import type { ToolContext } from '../src/types.js';

function okChain(content: string) {
  return {
    ok: true as const,
    content,
    model_used: 'free/primary',
    tokens_in: 10,
    tokens_out: 5,
    finish_reason: 'stop',
    fallback_chain: ['free/primary'],
    cost_usd: 0,
  };
}

function stubCtx(chainContent = 'answer') {
  const chain = vi.fn().mockResolvedValue(okChain(chainContent));
  const direct = vi.fn().mockResolvedValue(okChain(chainContent));
  const ctx: ToolContext = {
    client: { chatChain: chain, chatDirect: direct } as unknown as ToolContext['client'],
  };
  return { ctx, chain, direct };
}

function envelope(out: { content: Array<{ text: string }> }) {
  return JSON.parse(out.content[0]!.text);
}

describe('query_free — input validation', () => {
  const noopCtx: ToolContext = {
    client: { chatChain: vi.fn(), chatDirect: vi.fn() } as unknown as ToolContext['client'],
  };

  it('rejects empty prompt with INVALID_INPUT', async () => {
    const env = envelope(await handler({ prompt: '' }, noopCtx));
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects missing prompt with INVALID_INPUT', async () => {
    const env = envelope(await handler({}, noopCtx));
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects invalid task_type with INVALID_INPUT', async () => {
    const env = envelope(await handler({ prompt: 'hi', task_type: 'unknown_task' }, noopCtx));
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});

describe('query_free — chain routing', () => {
  it('routes through chatChain by default', async () => {
    const { ctx, chain, direct } = stubCtx('free answer');
    const env = envelope(await handler({ prompt: 'what is 2+2?' }, ctx));
    expect(env.result).toBe('free answer');
    expect(chain).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
  });

  it('routes through chatDirect when model override is provided', async () => {
    const { ctx, chain, direct } = stubCtx('direct answer');
    const env = envelope(await handler({ prompt: 'hi', model: 'specific/model' }, ctx));
    expect(env.result).toBe('direct answer');
    expect(direct).toHaveBeenCalledTimes(1);
    expect(chain).not.toHaveBeenCalled();
  });

  it('passes the model id to chatDirect when model is set', async () => {
    const { ctx, direct } = stubCtx('result');
    await handler({ prompt: 'hi', model: 'specific/model' }, ctx);
    const callArgs = direct.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.model).toBe('specific/model');
  });

  it('passes system prompt through composeMessages when provided', async () => {
    const { ctx, chain } = stubCtx('result');
    await handler({ prompt: 'hi', system: 'you are concise' }, ctx);
    const callArgs = chain.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    const sysMsg = callArgs.messages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toContain('you are concise');
  });

  it('returns success envelope with model_used and cost_usd', async () => {
    const { ctx } = stubCtx('answer');
    const env = envelope(await handler({ prompt: 'hi' }, ctx));
    expect(env.result).toBe('answer');
    expect(env.model_used).toBe('free/primary');
    expect(env.cost_usd).toBe(0);
    expect(env.fallback_chain).toEqual(['free/primary']);
  });

  it('surfaces chatChain error envelope directly', async () => {
    const chain = vi.fn().mockResolvedValue({
      ok: false,
      envelope: { error: { code: 'PAID_CONFIRMATION_REQUIRED', message: 'free exhausted', retryable: true, suggested_action: 'retry', estimated_cost_usd: 0.001 } },
      fallback_chain: ['free/primary', 'free/fallback'],
    });
    const ctx: ToolContext = {
      client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    const env = envelope(await handler({ prompt: 'hi' }, ctx));
    expect(env.error.code).toBe('PAID_CONFIRMATION_REQUIRED');
  });

  it('passes allow_paid through to chatChain', async () => {
    const { ctx, chain } = stubCtx('result');
    await handler({ prompt: 'hi', allow_paid: true }, ctx);
    const callArgs = chain.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.allow_paid).toBe(true);
  });
});
