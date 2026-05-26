/**
 * query_model tests — focused on:
 *   - Input validation (prompt + model required)
 *   - Always passes allow_paid: true to chatDirect (bypasses gate by design)
 *   - extra passthrough splatted into the request
 *   - Upstream error surfaced directly
 */

import { describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/query_model.js';
import type { ToolContext } from '../src/types.js';

function okDirect(content: string) {
  return {
    ok: true as const,
    content,
    model_used: 'some/model',
    tokens_in: 10,
    tokens_out: 5,
    finish_reason: 'stop',
    fallback_chain: ['some/model'],
    cost_usd: 0.0002,
  };
}

function stubCtx(directContent: string) {
  const direct = vi.fn().mockResolvedValue(okDirect(directContent));
  const chain = vi.fn();
  const ctx: ToolContext = {
    client: {
      chatChain: chain,
      chatDirect: direct,
    } as unknown as ToolContext['client'],
  };
  return { ctx, direct, chain };
}

function envelope(out: { content: Array<{ text: string }> }) {
  return JSON.parse(out.content[0]!.text);
}

describe('query_model — input validation', () => {
  const noopCtx: ToolContext = {
    client: { chatChain: vi.fn(), chatDirect: vi.fn() } as unknown as ToolContext['client'],
  };

  it('rejects missing prompt with INVALID_INPUT', async () => {
    const env = envelope(await handler({ model: 'some/model' }, noopCtx));
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects empty prompt with INVALID_INPUT', async () => {
    const env = envelope(await handler({ prompt: '', model: 'some/model' }, noopCtx));
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects missing model with INVALID_INPUT', async () => {
    const env = envelope(await handler({ prompt: 'hi' }, noopCtx));
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects temperature out of range with INVALID_INPUT', async () => {
    const env = envelope(await handler({ prompt: 'hi', model: 'some/model', temperature: 3 }, noopCtx));
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});

describe('query_model — happy path', () => {
  it('routes through chatDirect and returns success envelope', async () => {
    const { ctx, direct, chain } = stubCtx('the answer');
    const env = envelope(await handler({ prompt: 'hi', model: 'some/model' }, ctx));
    expect(env.result).toBe('the answer');
    expect(env.model_used).toBe('some/model');
    expect(env.cost_usd).toBe(0.0002);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(chain).not.toHaveBeenCalled();
  });

  it('always passes allow_paid: true to chatDirect regardless of caller arg', async () => {
    const { ctx, direct } = stubCtx('result');
    await handler({ prompt: 'hi', model: 'some/model', allow_paid: false }, ctx);
    const callArgs = direct.mock.calls[0]![0] as Record<string, unknown>;
    // query_model is a raw passthrough — allow_paid is advisory, not enforced.
    // The implementation hardcodes allow_paid: true so the model is never blocked.
    expect(callArgs.allow_paid).toBe(true);
  });

  it('splats extra fields into the chatDirect call', async () => {
    const { ctx, direct } = stubCtx('result');
    await handler(
      { prompt: 'hi', model: 'some/model', extra: { response_format: { type: 'json_object' } } },
      ctx,
    );
    const callArgs = direct.mock.calls[0]![0] as Record<string, unknown>;
    expect((callArgs.extra as Record<string, unknown>)?.response_format).toEqual({ type: 'json_object' });
  });

  it('passes system prompt through composeMessages when provided', async () => {
    const { ctx, direct } = stubCtx('result');
    await handler({ prompt: 'hi', model: 'some/model', system: 'you are a bot' }, ctx);
    const callArgs = direct.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    const sysMsg = callArgs.messages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toContain('you are a bot');
  });

  it('surfaces chatDirect error envelope directly', async () => {
    const direct = vi.fn().mockResolvedValue({
      ok: false,
      envelope: { error: { code: 'UPSTREAM_HTTP', message: 'server error', retryable: true, suggested_action: 'retry' } },
      fallback_chain: ['some/model'],
    });
    const ctx: ToolContext = {
      client: { chatChain: vi.fn(), chatDirect: direct } as unknown as ToolContext['client'],
    };
    const env = envelope(await handler({ prompt: 'hi', model: 'some/model' }, ctx));
    expect(env.error.code).toBe('UPSTREAM_HTTP');
  });
});
