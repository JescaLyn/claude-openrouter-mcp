/**
 * list_free_models tests — focused on:
 *   - Input validation (category enum)
 *   - Filters by category (all, text, vision, long_context)
 *   - stale_curated_ids surfaced in result
 *   - refresh: true forces a new probeModels() call
 *
 * probeModels is mocked at the module level so no real HTTP calls are made.
 * The real freeModels() implementation runs against the mocked ProbeResult.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/probe.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/probe.js')>();
  return { ...original, probeModels: vi.fn() };
});

import { probeModels } from '../src/probe.js';
import { handler } from '../src/tools/list_free_models.js';
import { OpenRouterClient } from '../src/client.js';
import type { ProbeResult } from '../src/probe.js';

const ctx = { client: new OpenRouterClient({ apiKey: 'test-key' }) };

const zeroPricing = {
  prompt: 0,
  completion: 0,
  image_output: 0,
  audio: 0,
  video_output: 0,
  request: 0,
};

const MOCK_PROBE: ProbeResult = {
  source: 'frontend',
  stale_curated_ids: ['old/stale-model'],
  models: [
    // free text-only, short context
    {
      id: 'free/text-model',
      name: 'Free Text Model',
      context_length: 100_000,
      is_free: true,
      input_modalities: ['text'],
      output_modalities: ['text'],
      pricing: zeroPricing,
      source: 'frontend',
    },
    // free vision model
    {
      id: 'free/vision-model',
      name: 'Free Vision Model',
      context_length: 128_000,
      is_free: true,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      pricing: zeroPricing,
      source: 'frontend',
    },
    // free long context (>=200K)
    {
      id: 'free/long-model',
      name: 'Free Long Context Model',
      context_length: 200_000,
      is_free: true,
      input_modalities: ['text'],
      output_modalities: ['text'],
      pricing: zeroPricing,
      source: 'frontend',
    },
    // paid model — must be excluded from all categories
    {
      id: 'paid/model',
      name: 'Paid Model',
      context_length: 100_000,
      is_free: false,
      input_modalities: ['text'],
      output_modalities: ['text'],
      pricing: { ...zeroPricing, prompt: 0.000003 },
      source: 'frontend',
    },
  ],
};

function envelope(out: { content: Array<{ text: string }> }) {
  return JSON.parse(out.content[0]!.text);
}

describe('list_free_models — input validation', () => {
  it('rejects invalid category with INVALID_INPUT', async () => {
    const env = envelope(await handler({ category: 'audio' }, ctx));
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});

describe('list_free_models — category filters', () => {
  beforeEach(() => {
    vi.mocked(probeModels).mockResolvedValue(MOCK_PROBE);
  });

  it('returns all 3 free models when category is "all"', async () => {
    const env = envelope(await handler({ category: 'all', refresh: true }, ctx));
    expect(env.result.count).toBe(3);
    expect(env.result.source).toBe('frontend');
    expect(env.result.category).toBe('all');
    // paid model must not appear
    expect(env.result.models.map((m: { id: string }) => m.id)).not.toContain('paid/model');
  });

  it('defaults to "all" when category omitted', async () => {
    const env = envelope(await handler({ refresh: true }, ctx));
    expect(env.result.count).toBe(3);
  });

  it('returns only the vision model when category is "vision"', async () => {
    const env = envelope(await handler({ category: 'vision', refresh: true }, ctx));
    expect(env.result.count).toBe(1);
    expect(env.result.models[0].id).toBe('free/vision-model');
  });

  it('returns only models with context_length >= 200K when category is "long_context"', async () => {
    const env = envelope(await handler({ category: 'long_context', refresh: true }, ctx));
    expect(env.result.count).toBe(1);
    expect(env.result.models[0].id).toBe('free/long-model');
  });

  it('returns only text-in/text-out models when category is "text"', async () => {
    const env = envelope(await handler({ category: 'text', refresh: true }, ctx));
    // text-model and long-model are text-only; vision-model has image input so excluded
    const ids = env.result.models.map((m: { id: string }) => m.id);
    expect(ids).toContain('free/text-model');
    expect(ids).toContain('free/long-model');
    expect(ids).not.toContain('free/vision-model');
  });

  it('includes stale_curated_ids in the result', async () => {
    const env = envelope(await handler({ refresh: true }, ctx));
    expect(env.result.stale_curated_ids).toEqual(['old/stale-model']);
  });

  it('calls probeModels again on refresh: true', async () => {
    vi.mocked(probeModels).mockClear();
    await handler({ refresh: true }, ctx);
    await handler({ refresh: true }, ctx);
    expect(vi.mocked(probeModels)).toHaveBeenCalledTimes(2);
  });

  it('does not call probeModels again on refresh: false after a warm call', async () => {
    vi.mocked(probeModels).mockClear();
    await handler({ refresh: true }, ctx);  // warm the cache
    await handler({ refresh: false }, ctx); // should use cache
    expect(vi.mocked(probeModels)).toHaveBeenCalledTimes(1);
  });

  it('returns UPSTREAM_HTTP when probeModels throws', async () => {
    vi.mocked(probeModels).mockRejectedValueOnce(new Error('network error'));
    const env = envelope(await handler({ refresh: true }, ctx));
    expect(env.error.code).toBe('UPSTREAM_HTTP');
  });

  it('exposes model id, context_length, and modalities in each entry', async () => {
    const env = envelope(await handler({ category: 'vision', refresh: true }, ctx));
    const m = env.result.models[0];
    expect(m.id).toBe('free/vision-model');
    expect(m.context_length).toBe(128_000);
    expect(m.input_modalities).toContain('image');
    expect(m.output_modalities).toContain('text');
  });
});
