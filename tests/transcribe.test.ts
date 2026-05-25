/**
 * transcribe tests — focused on:
 *   - Cost-confirmation envelope shape when allow_paid is omitted/false
 *   - Per-minute math, default 60s when no duration hint
 *   - Successful upstream call extracts transcript from chat completions response
 *   - Upstream non-OK surfaces structured error
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/transcribe.js';
import { OpenRouterClient } from '../src/client.js';

const ctx = { client: new OpenRouterClient({ apiKey: 'test-key' }) };

function parseEnvelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

describe('transcribe — cost confirmation', () => {
  it('returns PAID_CONFIRMATION_REQUIRED when allow_paid is omitted', async () => {
    const result = await handler({ audio: 'aGVsbG8=', format: 'mp3' }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('PAID_CONFIRMATION_REQUIRED');
    expect(env.error.estimated_cost_usd).toBeGreaterThanOrEqual(0);
    expect(env.error.suggested_paid_model).toBe('mistralai/voxtral-small-24b-2507');
    expect(env.error.cost_breakdown).toContain('Voxtral Small');
  });

  it('defaults to 60s when no duration hint', async () => {
    const result = await handler({ audio: 'aGVsbG8=', format: 'mp3' }, ctx);
    const env = parseEnvelope(result);
    // 60s = 1 min × $0.0001 = $0.0001
    expect(env.error.estimated_cost_usd).toBeCloseTo(0.0001, 6);
    expect(env.error.cost_breakdown).toContain('default 60s estimate');
  });

  it('uses duration_seconds_hint when provided', async () => {
    const result = await handler(
      { audio: 'aGVsbG8=', format: 'mp3', duration_seconds_hint: 600 },
      ctx,
    );
    const env = parseEnvelope(result);
    // 600s = 10 min × $0.0001 = $0.001
    expect(env.error.estimated_cost_usd).toBeCloseTo(0.001, 6);
    expect(env.error.cost_breakdown).toContain('600s hinted');
  });

  it('switches to Gemini 2.5 Flash Lite rate when model overridden', async () => {
    const result = await handler(
      {
        audio: 'aGVsbG8=',
        format: 'mp3',
        duration_seconds_hint: 600,
        model: 'google/gemini-2.5-flash-lite',
      },
      ctx,
    );
    const env = parseEnvelope(result);
    // 10 min × $0.0018 = $0.018
    expect(env.error.estimated_cost_usd).toBeCloseTo(0.018, 6);
    expect(env.error.cost_breakdown).toContain('Gemini');
  });

  it('rejects unknown format with INVALID_INPUT', async () => {
    const result = await handler({ audio: 'aGVsbG8=', format: 'aiff' }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects empty audio with INVALID_INPUT', async () => {
    const result = await handler({ audio: '', format: 'mp3' }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});

describe('transcribe — paid path', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function chatResponse(content: string) {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  it('extracts transcript from chat completions response', async () => {
    fetchSpy.mockResolvedValueOnce(chatResponse('Hello world. This is a test.'));

    const result = await handler(
      { audio: 'aGVsbG8=', format: 'mp3', allow_paid: true },
      ctx,
    );
    const env = parseEnvelope(result);
    expect(env.result.text).toBe('Hello world. This is a test.');
    expect(env.model_used).toBe('mistralai/voxtral-small-24b-2507');
    expect(env.cost_usd).toBeCloseTo(0.0001, 6);
  });

  it('appends language hint to prompt', async () => {
    fetchSpy.mockResolvedValueOnce(chatResponse('Bonjour le monde.'));

    await handler(
      {
        audio: 'aGVsbG8=',
        format: 'mp3',
        allow_paid: true,
        language_hint: 'fr',
      },
      ctx,
    );

    const callArgs = fetchSpy.mock.calls[0]?.[1] as { body: string };
    const body = JSON.parse(callArgs.body);
    const textBlock = body.messages[0].content[0];
    expect(textBlock.text).toContain('Language hint: fr');
  });

  it('packages audio as input_audio block', async () => {
    fetchSpy.mockResolvedValueOnce(chatResponse('text'));

    await handler(
      { audio: 'AAAAAA==', format: 'wav', allow_paid: true },
      ctx,
    );
    const callArgs = fetchSpy.mock.calls[0]?.[1] as { body: string };
    const body = JSON.parse(callArgs.body);
    const audioBlock = body.messages[0].content[1];
    expect(audioBlock.type).toBe('input_audio');
    expect(audioBlock.input_audio.data).toBe('AAAAAA==');
    expect(audioBlock.input_audio.format).toBe('wav');
  });

  it('surfaces empty transcript as UPSTREAM_HTTP', async () => {
    fetchSpy.mockResolvedValueOnce(chatResponse(''));
    const result = await handler(
      { audio: 'aGVsbG8=', format: 'mp3', allow_paid: true },
      ctx,
    );
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('UPSTREAM_HTTP');
  });
});
