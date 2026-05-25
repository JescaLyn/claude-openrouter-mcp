/**
 * generate_audio tests — focused on:
 *   - Cost-confirmation envelope shape when allow_paid is omitted/false
 *   - Per-character cost math
 *   - Successful upstream call reads raw bytes and base64-encodes
 *   - Upstream non-OK surfaces structured error
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/generate_audio.js';
import { OpenRouterClient } from '../src/client.js';

const ctx = { client: new OpenRouterClient({ apiKey: 'test-key' }) };

function parseEnvelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

describe('generate_audio — cost confirmation', () => {
  it('returns PAID_CONFIRMATION_REQUIRED when allow_paid is omitted', async () => {
    const result = await handler({ text: 'Hello world.' }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('PAID_CONFIRMATION_REQUIRED');
    expect(env.error.estimated_cost_usd).toBeGreaterThan(0);
    expect(env.error.suggested_paid_model).toBe('openai/gpt-4o-mini-tts-2025-12-15');
    expect(env.error.cost_breakdown).toContain('GPT-4o Mini TTS');
  });

  it('estimates cost as length * per-char rate for default model', async () => {
    const text = 'a'.repeat(5000);
    const result = await handler({ text }, ctx);
    const env = parseEnvelope(result);
    // 5000 * 0.0000006 = 0.003
    expect(env.error.estimated_cost_usd).toBeCloseTo(0.003, 6);
  });

  it('uses Voxtral Mini TTS rate when model overridden', async () => {
    const result = await handler(
      { text: 'a'.repeat(1000), model: 'mistralai/voxtral-mini-tts' },
      ctx,
    );
    const env = parseEnvelope(result);
    // 1000 * 0.000016 = 0.016
    expect(env.error.estimated_cost_usd).toBeCloseTo(0.016, 6);
    expect(env.error.cost_breakdown).toContain('Voxtral Mini TTS');
  });

  it('rejects empty text with INVALID_INPUT', async () => {
    const result = await handler({ text: '' }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});

describe('generate_audio — paid path', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads raw bytes and base64-encodes them', async () => {
    const audioBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04]); // "ID3\x04" — ID3 mp3 header
    fetchSpy.mockResolvedValueOnce(
      new Response(audioBytes, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    const result = await handler({ text: 'hi', allow_paid: true }, ctx);
    const env = parseEnvelope(result);
    expect(env.result.audio_base64).toBe(Buffer.from(audioBytes).toString('base64'));
    expect(env.result.mime_type).toBe('audio/mpeg');
    expect(env.model_used).toBe('openai/gpt-4o-mini-tts-2025-12-15');
    expect(env.cost_usd).toBeGreaterThan(0);
  });

  it('uses correct mime type for wav format', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );
    const result = await handler({ text: 'hi', format: 'wav', allow_paid: true }, ctx);
    const env = parseEnvelope(result);
    expect(env.result.mime_type).toBe('audio/wav');
  });

  it('surfaces empty audio response as UPSTREAM_HTTP', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(new Uint8Array(0), { status: 200 }));
    const result = await handler({ text: 'hi', allow_paid: true }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('UPSTREAM_HTTP');
    expect(env.error.message).toContain('Empty');
  });
});
