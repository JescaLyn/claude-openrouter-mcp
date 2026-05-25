import { afterEach, describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/summarize.js';
import { OpenRouterClient } from '../src/client.js';

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
