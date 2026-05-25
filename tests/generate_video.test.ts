/**
 * generate_video tests — focused on:
 *   - Cost-confirmation envelope shape when allow_paid is omitted/false
 *   - Per-second × duration math by model/audio combination
 *   - Successful create + poll lifecycle returns video_url
 *   - Failed/timeout polling surfaces structured errors
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/generate_video.js';
import { OpenRouterClient } from '../src/client.js';

const ctx = { client: new OpenRouterClient({ apiKey: 'test-key' }) };

function parseEnvelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

describe('generate_video — cost confirmation', () => {
  it('returns PAID_CONFIRMATION_REQUIRED when allow_paid is omitted', async () => {
    const result = await handler({ prompt: 'a sunset over mountains' }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('PAID_CONFIRMATION_REQUIRED');
    expect(env.error.estimated_cost_usd).toBeGreaterThan(0);
    expect(env.error.suggested_paid_model).toBe('google/veo-3.1-lite');
  });

  it('estimates Veo 3.1 Lite at $0.03/sec × 5s = $0.15', async () => {
    const result = await handler({ prompt: 'x', duration_seconds: 5 }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.estimated_cost_usd).toBeCloseTo(0.15, 4);
    expect(env.error.cost_breakdown).toContain('Veo 3.1 Lite 720p');
  });

  it('charges audio premium when with_audio: true', async () => {
    const result = await handler(
      { prompt: 'x', duration_seconds: 5, with_audio: true },
      ctx,
    );
    const env = parseEnvelope(result);
    // Veo Lite + audio: $0.10/sec × 5 = $0.50
    expect(env.error.estimated_cost_usd).toBeCloseTo(0.50, 4);
    expect(env.error.cost_breakdown).toContain('audio');
  });

  it('switches to Veo 3.1 Fast 1080p+audio rate when model+resolution set', async () => {
    const result = await handler(
      {
        prompt: 'x',
        duration_seconds: 5,
        resolution: '1080p',
        with_audio: true,
        model: 'google/veo-3.1-fast',
      },
      ctx,
    );
    const env = parseEnvelope(result);
    // 0.12 * 5 = 0.60
    expect(env.error.estimated_cost_usd).toBeCloseTo(0.60, 4);
  });

  it('rejects empty prompt with INVALID_INPUT', async () => {
    const result = await handler({ prompt: '' }, ctx);
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});

describe('generate_video — paid lifecycle', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function createResponse(body: object, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('creates job, polls once, returns video_url on completed', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        createResponse({ id: 'job-1', polling_url: 'https://or/v1/videos/job-1', status: 'pending' }),
      )
      .mockResolvedValueOnce(
        createResponse({ status: 'completed', unsigned_urls: ['https://cdn/video.mp4'] }),
      );

    const promise = handler({ prompt: 'sunset', allow_paid: true }, ctx);
    // Advance past one poll interval (5s).
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;
    const env = parseEnvelope(result);

    expect(env.result.video_url).toBe('https://cdn/video.mp4');
    expect(env.result.duration_seconds).toBe(5);
    expect(env.result.job_id).toBe('job-1');
    expect(env.cost_usd).toBeCloseTo(0.15, 4);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('surfaces upstream failure when status: failed', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        createResponse({ id: 'job-2', polling_url: 'https://or/v1/videos/job-2', status: 'pending' }),
      )
      .mockResolvedValueOnce(
        createResponse({ status: 'failed', error: { message: 'content policy' } }),
      );

    const promise = handler({ prompt: 'forbidden', allow_paid: true }, ctx);
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;
    const env = parseEnvelope(result);

    expect(env.error.code).toBe('UPSTREAM_HTTP');
    expect(env.error.message).toContain('content policy');
  });

  it('returns UPSTREAM_TIMEOUT with polling URL when deadline hit', async () => {
    fetchSpy.mockResolvedValueOnce(
      createResponse({ id: 'job-3', polling_url: 'https://or/v1/videos/job-3', status: 'pending' }),
    );
    // All subsequent polls return pending.
    fetchSpy.mockResolvedValue(createResponse({ status: 'running' }));

    const promise = handler(
      { prompt: 'x', allow_paid: true, poll_timeout_seconds: 10 },
      ctx,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await promise;
    const env = parseEnvelope(result);

    expect(env.error.code).toBe('UPSTREAM_TIMEOUT');
    // SECURITY: an off-host polling_url in the upstream response is ignored —
    // the bearer token must never travel to a host the response can name freely.
    // The suggested action falls back to the canonical openrouter.ai URL.
    expect(env.error.suggested_action).toContain('https://openrouter.ai/api/v1/videos/job-3');
  });

  it('surfaces 404 from create as MODEL_NOT_FOUND', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    const result = await handler(
      { prompt: 'x', model: 'unknown/model', allow_paid: true },
      ctx,
    );
    const env = parseEnvelope(result);
    expect(env.error.code).toBe('MODEL_NOT_FOUND');
  });

  it('exits the poll loop and returns UPSTREAM_TIMEOUT when the request is aborted', async () => {
    fetchSpy.mockResolvedValueOnce(
      createResponse({ id: 'job-abort', polling_url: 'https://openrouter.ai/api/v1/videos/job-abort', status: 'pending' }),
    );

    const ac = new AbortController();
    const abortCtx = { client: new OpenRouterClient({ apiKey: 'test-key' }), signal: ac.signal };
    const promise = handler({ prompt: 'x', allow_paid: true }, abortCtx);

    // Abort synchronously — signal is aborted before the create-fetch microtask resolves,
    // so by the time the while loop's first condition check runs, signal.aborted is true.
    ac.abort();
    const result = await promise;
    const env = parseEnvelope(result);

    expect(env.error.code).toBe('UPSTREAM_TIMEOUT');
    expect(env.error.message).toContain('cancelled');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // job created, no polls ran
  });
});
