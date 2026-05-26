/**
 * generate_image tests — focused on:
 *   - Cost-confirmation envelope shape when allow_paid is omitted/false
 *   - Per-MP vs flat pricing math
 *   - Successful upstream call extracts image_url and strips the data: prefix
 *   - Upstream non-OK surfaces structured error
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/generate_image.js';
import { OpenRouterClient } from '../src/client.js';

const ctx = { client: new OpenRouterClient({ apiKey: 'test-key' }) };

function parseEnvelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

describe('generate_image — cost confirmation', () => {
  it('returns PAID_CONFIRMATION_REQUIRED when allow_paid is omitted', async () => {
    const result = await handler({ prompt: 'a cat astronaut' }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('PAID_CONFIRMATION_REQUIRED');
    expect(env.error.estimated_cost_usd).toBeGreaterThan(0);
    expect(env.error.suggested_paid_model).toBe('black-forest-labs/flux.2-klein-4b');
    expect(env.error.cost_breakdown).toContain('FLUX.2 Klein 4B');
  });

  it('estimates per-MP for FLUX models at 1K (~1MP)', async () => {
    const result = await handler({ prompt: 'x', size: '1K' }, ctx);
    const env = parseEnvelope(result);
    // 1.05MP * 0.014 = 0.0147
    expect(env.error.estimated_cost_usd).toBeCloseTo(0.0147, 4);
  });

  it('estimates per-MP for FLUX Pro at 4K (~16.8MP)', async () => {
    const result = await handler(
      { prompt: 'x', size: '4K', model: 'black-forest-labs/flux.2-pro' },
      ctx,
    );
    const env = parseEnvelope(result);
    // 16.8 * 0.030 = 0.504
    expect(env.error.estimated_cost_usd).toBeCloseTo(0.504, 3);
    expect(env.error.cost_breakdown).toContain('FLUX.2 Pro');
  });

  it('estimates flat for Gemini Flash Image regardless of size', async () => {
    const result = await handler(
      { prompt: 'x', size: '4K', model: 'google/gemini-2.5-flash-image' },
      ctx,
    );
    const env = parseEnvelope(result);
    expect(env.error.estimated_cost_usd).toBe(0.030);
    expect(env.error.cost_breakdown).toContain('flat');
  });

  it('rejects empty prompt with INVALID_INPUT', async () => {
    const result = await handler({ prompt: '' }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});

describe('generate_image — paid path', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('strips data: prefix and returns image_base64 + mime_type', async () => {
    const fakeBase64 = 'aGVsbG8=';
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                images: [{ image_url: { url: `data:image/png;base64,${fakeBase64}` } }],
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await handler({ prompt: 'a cat astronaut', allow_paid: true }, ctx);
    const env = parseEnvelope(result);
    expect(env.result.image_base64).toBe(fakeBase64);
    expect(env.result.mime_type).toBe('image/png');
    expect(env.model_used).toBe('black-forest-labs/flux.2-klein-4b');
    expect(env.cost_usd).toBeCloseTo(0.0147, 4);
  });

  it('surfaces UPSTREAM_HTTP on non-OK response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    const result = await handler({ prompt: 'x', allow_paid: true }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('UPSTREAM_HTTP');
    expect(env.error.retryable).toBe(true);
  });

  it('returns MODEL_NOT_FOUND on 404', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    const result = await handler(
      { prompt: 'x', model: 'nonexistent/model', allow_paid: true },
      ctx,
    );
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('MODEL_NOT_FOUND');
  });

  it('returns RATE_LIMITED on 429', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    const result = await handler({ prompt: 'x', allow_paid: true }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('RATE_LIMITED');
    expect(env.error.retryable).toBe(true);
  });

  it('returns UPSTREAM_TIMEOUT when fetch throws a TimeoutError', async () => {
    const timeoutErr = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    fetchSpy.mockRejectedValueOnce(timeoutErr);
    const result = await handler({ prompt: 'x', allow_paid: true }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('UPSTREAM_TIMEOUT');
    expect(env.error.retryable).toBe(true);
  });

  it('returns UPSTREAM_HTTP when response body is non-JSON', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('not json at all', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const result = await handler({ prompt: 'x', allow_paid: true }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('UPSTREAM_HTTP');
    expect(env.error.retryable).toBe(true);
  });

  it('returns UPSTREAM_HTTP when response has no image_url', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { images: [] }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const result = await handler({ prompt: 'x', allow_paid: true }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('UPSTREAM_HTTP');
  });

  it('sends multipart content array when reference_image is provided', async () => {
    const fakeBase64 = 'aGVsbG8=';
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                images: [{ image_url: { url: `data:image/png;base64,${fakeBase64}` } }],
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await handler(
      {
        prompt: 'modify this',
        reference_image: 'https://example.com/ref.png',
        allow_paid: true,
      },
      ctx,
    );
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(Array.isArray(body.messages[0].content)).toBe(true);
    const contentBlocks = body.messages[0].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(contentBlocks.some((b) => b.type === 'image_url')).toBe(true);
    expect(contentBlocks.find((b) => b.type === 'image_url')?.image_url?.url).toBe('https://example.com/ref.png');
  });
});

describe('generate_image — cost confirmation (unknown model)', () => {
  it('uses $0.10 defensive estimate for an unrecognised model id', async () => {
    const result = await handler({ prompt: 'x', model: 'unknown/image-model' }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('PAID_CONFIRMATION_REQUIRED');
    expect(env.error.estimated_cost_usd).toBe(0.10);
    expect(env.error.cost_breakdown).toContain('defensive estimate');
  });
});
