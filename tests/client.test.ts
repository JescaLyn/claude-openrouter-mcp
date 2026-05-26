/**
 * Client tests — focused on the load-bearing logic:
 *   - 429 retry with Retry-After / X-RateLimit-Reset
 *   - Three-tier fallback chain
 *   - Paid gate emits PAID_CONFIRMATION_REQUIRED on free exhaustion
 *
 * Uses a stubbed global fetch — vitest's vi.stubGlobal handles the cleanup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenRouterClient } from '../src/client.js';
import type { TaskModelChain } from '../src/types.js';

const TEST_CHAIN: TaskModelChain = {
  free_primary: 'free/primary',
  free_fallback: 'free/fallback',
  paid_escalation: 'paid/escalation',
  paid_cost_note: 'test paid model · ~$0.001/call',
};

function okResponse(content: string, opts: { tokens_in?: number; tokens_out?: number } = {}) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: opts.tokens_in ?? 10,
        completion_tokens: opts.tokens_out ?? 5,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function rateLimited(opts: { retryAfterSeconds?: number; resetEpochMs?: number } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.retryAfterSeconds !== undefined) headers['retry-after'] = String(opts.retryAfterSeconds);
  if (opts.resetEpochMs !== undefined) headers['x-ratelimit-reset'] = String(opts.resetEpochMs);
  return new Response(JSON.stringify({ error: { code: 429 } }), { status: 429, headers });
}

function serverError() {
  return new Response('upstream', { status: 503 });
}

describe('OpenRouterClient.chatChain', () => {
  let client: OpenRouterClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    client = new OpenRouterClient({ apiKey: 'test-key' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns the primary model result on first-call success', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse('hello from primary'));
    const result = await client.chatChain({
      chain: TEST_CHAIN,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('hello from primary');
    expect(result.model_used).toBe('free/primary');
    expect(result.fallback_chain).toEqual(['free/primary']);
    expect(result.cost_usd).toBe(0);
  });

  it('falls back to free/fallback when primary returns 5xx', async () => {
    fetchSpy.mockResolvedValueOnce(serverError());
    fetchSpy.mockResolvedValueOnce(okResponse('hello from fallback'));
    const result = await client.chatChain({
      chain: TEST_CHAIN,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model_used).toBe('free/fallback');
    expect(result.fallback_chain).toEqual(['free/primary', 'free/fallback']);
  });

  it('returns PAID_CONFIRMATION_REQUIRED when both free models fail and allow_paid=false', async () => {
    fetchSpy.mockResolvedValue(serverError());
    const result = await client.chatChain({
      chain: TEST_CHAIN,
      messages: [{ role: 'user', content: 'hi' }],
      allow_paid: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.envelope.error.code).toBe('PAID_CONFIRMATION_REQUIRED');
    expect(result.envelope.error.suggested_paid_model).toBe('paid/escalation');
    expect(result.envelope.error.cost_breakdown).toContain('test paid model');
    expect(result.fallback_chain).toEqual(['free/primary', 'free/fallback']);
  });

  it('escalates to paid when allow_paid=true and free chain fails', async () => {
    fetchSpy.mockResolvedValueOnce(serverError()); // primary
    fetchSpy.mockResolvedValueOnce(serverError()); // fallback
    fetchSpy.mockResolvedValueOnce(okResponse('hello from paid')); // paid
    const result = await client.chatChain({
      chain: TEST_CHAIN,
      messages: [{ role: 'user', content: 'hi' }],
      allow_paid: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model_used).toBe('paid/escalation');
    expect(result.fallback_chain).toEqual(['free/primary', 'free/fallback', 'paid/escalation']);
  });

  it('honors Retry-After: sleeps, then succeeds on retry', async () => {
    vi.useFakeTimers();
    // First call: 429 with Retry-After: 2 seconds.
    // Second call (after sleep): 200.
    fetchSpy.mockResolvedValueOnce(rateLimited({ retryAfterSeconds: 2 }));
    fetchSpy.mockResolvedValueOnce(okResponse('after retry'));

    const promise = client.chatChain({
      chain: TEST_CHAIN,
      messages: [{ role: 'user', content: 'hi' }],
    });

    // Advance timers past the sleep, then await.
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await promise;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('after retry');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('fails fast on 429 when Retry-After exceeds 60s', async () => {
    fetchSpy.mockResolvedValue(rateLimited({ retryAfterSeconds: 120 }));
    const result = await client.chatChain({
      chain: TEST_CHAIN,
      messages: [{ role: 'user', content: 'hi' }],
      allow_paid: false,
    });
    // Both free models 429; no paid → PAID_CONFIRMATION_REQUIRED.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.envelope.error.code).toBe('PAID_CONFIRMATION_REQUIRED');
    // Important: each model attempted exactly once (no retry, because wait > 60s).
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns MODEL_NOT_FOUND through chain when model returns 404', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    fetchSpy.mockResolvedValueOnce(okResponse('fallback worked'));
    const result = await client.chatChain({
      chain: TEST_CHAIN,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model_used).toBe('free/fallback');
  });

  it('parses Retry-After as an HTTP-date and sleeps until that time', async () => {
    vi.useFakeTimers();
    const futureMs = Date.now() + 3_000;
    const httpDate = new Date(futureMs).toUTCString();
    // Primary model: 429 with Retry-After as an HTTP-date string (parseInt returns NaN).
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 429 } }), {
        status: 429,
        headers: { 'retry-after': httpDate },
      }),
    );
    fetchSpy.mockResolvedValueOnce(okResponse('after http-date retry'));

    const promise = client.chatChain({
      chain: TEST_CHAIN,
      messages: [{ role: 'user', content: 'hi' }],
    });
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await promise;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('after http-date retry');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('uses x-ratelimit-reset epoch ms header when Retry-After is absent', async () => {
    vi.useFakeTimers();
    const resetEpochMs = Date.now() + 2_000;
    fetchSpy.mockResolvedValueOnce(rateLimited({ resetEpochMs }));
    fetchSpy.mockResolvedValueOnce(okResponse('after reset'));

    const promise = client.chatChain({
      chain: TEST_CHAIN,
      messages: [{ role: 'user', content: 'hi' }],
    });
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await promise;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('after reset');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('sleeps for the maximum of Retry-After and x-ratelimit-reset when both are present', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    // Retry-After: 1 second, x-ratelimit-reset: now + 3000 ms (longer).
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 429 } }), {
        status: 429,
        headers: {
          'retry-after': '1',
          'x-ratelimit-reset': String(now + 3_000),
        },
      }),
    );
    fetchSpy.mockResolvedValueOnce(okResponse('after max'));

    const promise = client.chatChain({
      chain: TEST_CHAIN,
      messages: [{ role: 'user', content: 'hi' }],
    });
    // Advancing only 1.5s should NOT be enough — the max wait is 3s.
    await vi.advanceTimersByTimeAsync(1_500);
    // Still pending at 1.5s
    let settled = false;
    promise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;
    expect(result.ok).toBe(true);
  });
});

describe('OpenRouterClient.chatDirect', () => {
  let client: OpenRouterClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    client = new OpenRouterClient({ apiKey: 'test-key' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns success on direct call', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse('direct hit'));
    const result = await client.chatDirect({
      model: 'foo/bar',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('direct hit');
    expect(result.fallback_chain).toEqual(['foo/bar']);
  });

  it('does NOT fallback on direct call (no chain)', async () => {
    fetchSpy.mockResolvedValueOnce(serverError());
    const result = await client.chatDirect({
      model: 'foo/bar',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.envelope.error.code).toBe('UPSTREAM_HTTP');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('OpenRouterClient.chatDirect — free model gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns PAID_CONFIRMATION_REQUIRED when model is not in freeModelIds and allow_paid is false', async () => {
    const client = new OpenRouterClient({
      apiKey: 'test-key',
      freeModelIds: new Set(['free/model-a']),
    });
    const result = await client.chatDirect({
      model: 'paid/some-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.envelope.error.code).toBe('PAID_CONFIRMATION_REQUIRED');
    expect(result.envelope.error.retryable).toBe(true);
    expect(result.envelope.error.estimated_cost_usd).toBe(0);
    expect(result.envelope.error.cost_breakdown).toBeDefined();
    expect(result.fallback_chain).toEqual(['paid/some-model']);
  });

  it('passes through when model IS in freeModelIds', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(okResponse('free hit'));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new OpenRouterClient({
      apiKey: 'test-key',
      freeModelIds: new Set(['free/model-a']),
    });
    const result = await client.chatDirect({
      model: 'free/model-a',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('free hit');
  });

  it('passes through when freeModelIds is undefined (probe not ready)', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(okResponse('no gate'));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new OpenRouterClient({ apiKey: 'test-key' });
    const result = await client.chatDirect({
      model: 'paid/some-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('no gate');
  });

  it('passes through when allow_paid is true even if model is not in freeModelIds', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(okResponse('paid approved'));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new OpenRouterClient({
      apiKey: 'test-key',
      freeModelIds: new Set(['free/model-a']),
    });
    const result = await client.chatDirect({
      model: 'paid/some-model',
      allow_paid: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('paid approved');
  });
});
