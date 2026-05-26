import { afterEach, describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/summarize.js';
import { OpenRouterClient } from '../src/client.js';
import type { ToolContext } from '../src/types.js';

function parseEnvelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

describe('summarize — model override allow_paid gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns PAID_CONFIRMATION_REQUIRED when model override is paid and allow_paid is false', async () => {
    const gatedCtx = {
      client: new OpenRouterClient({
        apiKey: 'test-key',
        freeModelIds: new Set(['free/model-a']),
      }),
    };
    const result = await handler(
      { text: 'hello world', model: 'paid/some-model' },
      gatedCtx,
    );
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('PAID_CONFIRMATION_REQUIRED');
  });

  it('passes through when model override is paid and allow_paid is true', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'summary text' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const gatedCtx = {
      client: new OpenRouterClient({
        apiKey: 'test-key',
        freeModelIds: new Set(['free/model-a']),
      }),
    };
    const result = await handler(
      { text: 'hello world', model: 'paid/some-model', allow_paid: true },
      gatedCtx,
    );
    const env = parseEnvelope(result);
    expect(env.result).toBe('summary text');
    expect(env.model_used).toBe('paid/some-model');
  });
});

const ctx = { client: new OpenRouterClient({ apiKey: 'test-key' }) };

describe('summarize — free chain happy path', () => {
  it('routes through chatChain and returns the summary as result', async () => {
    const chain = vi.fn().mockResolvedValue({
      ok: true as const,
      content: 'A brief summary.',
      model_used: 'free/primary',
      tokens_in: 20,
      tokens_out: 8,
      finish_reason: 'stop',
      fallback_chain: ['free/primary'],
      cost_usd: 0,
    });
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    const result = await handler({ text: 'Long article text here.' }, tctx);
    const env = parseEnvelope(result);
    expect(env.result).toBe('A brief summary.');
    expect(env.model_used).toBe('free/primary');
    expect(env.cost_usd).toBe(0);
    expect(chain).toHaveBeenCalledTimes(1);
  });

  it('uses the summarize_long chain when text length >= 30 000 chars', async () => {
    const chain = vi.fn().mockResolvedValue({
      ok: true as const,
      content: 'Long summary.',
      model_used: 'free/long-primary',
      tokens_in: 10000,
      tokens_out: 50,
      finish_reason: 'stop',
      fallback_chain: ['free/long-primary'],
      cost_usd: 0,
    });
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    const longText = 'x'.repeat(30_000);
    const result = await handler({ text: longText }, tctx);
    const env = parseEnvelope(result);
    expect(env.result).toBe('Long summary.');
    // The chain arg includes the chain config; the key difference vs short text
    // is that the chain selected is 'summarize_long' — verify chatChain was called
    // (not chatDirect) and with a chain containing a long-context primary model.
    expect(chain).toHaveBeenCalledTimes(1);
    const callArg = chain.mock.calls[0]![0] as { chain: { free_primary: string } };
    expect(callArg.chain.free_primary).toBe('qwen/qwen3-next-80b-a3b-instruct');
  });

  it('surfaces upstream error from chatChain as-is', async () => {
    const chain = vi.fn().mockResolvedValue({
      ok: false,
      envelope: { error: { code: 'UPSTREAM_HTTP', message: 'upstream failed', retryable: true } },
      fallback_chain: ['free/primary'],
    });
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    const result = await handler({ text: 'some text' }, tctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('UPSTREAM_HTTP');
  });
});

describe('summarize input validation', () => {
  it('rejects missing text', async () => {
    const res = await handler({}, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects empty text', async () => {
    const res = await handler({ text: '' }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects style outside the enum', async () => {
    const res = await handler({ text: 'hi', style: 'verbose' }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects negative max_chars', async () => {
    const res = await handler({ text: 'hi', max_chars: -10 }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });
});
