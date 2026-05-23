/**
 * Startup model probe.
 *
 * Three-source fallback chain:
 *   1. /api/frontend/models  (full 700+ catalog incl. image/audio/video; UNDOCUMENTED)
 *   2. /api/v1/models        (documented, but only ~360 chat-completion models)
 *   3. src/models.snapshot.json  (offline build-time snapshot)
 *
 * Also applies the pricing trap check — a model is truly free only when ALL
 * of pricing.{prompt,completion,image_output,audio,video_output,request} are
 * zero or absent. Don't trust just the token columns. See docs/MODELS.md.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { ModelInfo } from './types.js';
import { curatedFreeModels } from './models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FRONTEND_URL = 'https://openrouter.ai/api/frontend/models';
const V1_URL = 'https://openrouter.ai/api/v1/models';
const SNAPSHOT_PATH = join(__dirname, 'models.snapshot.json');
const PROBE_TIMEOUT_MS = 10_000;

interface SnapshotShape {
  probed_at: string;
  source: 'frontend' | 'v1' | 'snapshot';
  total: number;
  data: ModelInfo[];
}

/**
 * Number-or-string-or-undefined → number. Pricing fields come back as strings
 * from /api/frontend/models (e.g. "0.000008") and we want them numeric.
 */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v !== '') return Number.parseFloat(v) || 0;
  return 0;
}

/**
 * Apply the pricing trap check: a model is truly free only when EVERY
 * non-zero pricing field is zero or absent. Token-column $0 alone is not enough.
 */
export function isTrulyFree(pricing: ModelInfo['pricing']): boolean {
  return (
    pricing.prompt === 0 &&
    pricing.completion === 0 &&
    pricing.image_output === 0 &&
    pricing.audio === 0 &&
    pricing.video_output === 0 &&
    pricing.request === 0
  );
}

/** Parse the /api/frontend/models response shape into our slim ModelInfo. */
function parseFrontend(json: unknown): ModelInfo[] {
  const data = (json as { data?: Array<Record<string, unknown>> })?.data;
  if (!Array.isArray(data)) return [];
  const result: ModelInfo[] = [];
  for (const m of data) {
    const endpoint = m.endpoint as Record<string, unknown> | null | undefined;
    if (!endpoint) continue; // skip unprovisioned / "coming soon" entries
    const pricing = (endpoint.pricing as Record<string, unknown>) ?? {};
    const slug = m.slug as string | undefined;
    if (!slug) continue;
    result.push({
      id: slug,
      name: (m.name as string | undefined) ?? slug,
      context_length: typeof m.context_length === 'number' ? m.context_length : 0,
      is_free: endpoint.is_free === true,
      input_modalities: (m.input_modalities as string[] | undefined) ?? [],
      output_modalities: (m.output_modalities as string[] | undefined) ?? [],
      pricing: {
        prompt: num(pricing.prompt),
        completion: num(pricing.completion),
        image_output: num(pricing.image_output),
        audio: num(pricing.audio),
        video_output: num(pricing.video_output),
        request: num(pricing.request),
      },
      source: 'frontend',
    });
  }
  return result;
}

/** Parse the /api/v1/models response — different shape, only chat-completion models. */
function parseV1(json: unknown): ModelInfo[] {
  const data = (json as { data?: Array<Record<string, unknown>> })?.data;
  if (!Array.isArray(data)) return [];
  const result: ModelInfo[] = [];
  for (const m of data) {
    const id = m.id as string | undefined;
    if (!id) continue;
    const arch = (m.architecture as Record<string, unknown>) ?? {};
    const pricing = (m.pricing as Record<string, unknown>) ?? {};
    const promptPrice = num(pricing.prompt);
    const completionPrice = num(pricing.completion);
    result.push({
      id,
      name: (m.name as string | undefined) ?? id,
      context_length: typeof m.context_length === 'number' ? m.context_length : 0,
      // v1 doesn't expose endpoint.is_free directly; infer from token pricing only.
      // This misses image/audio/video models that bill via non-token fields — treat
      // any result with source:'v1' as potentially incomplete for non-chat models.
      is_free: promptPrice === 0 && completionPrice === 0,
      input_modalities: (arch.input_modalities as string[] | undefined) ?? [],
      output_modalities: (arch.output_modalities as string[] | undefined) ?? [],
      pricing: {
        prompt: promptPrice,
        completion: completionPrice,
        image_output: 0, // v1 doesn't expose these
        audio: 0,
        video_output: 0,
        request: num(pricing.request),
      },
      source: 'v1',
    });
  }
  return result;
}

async function tryFetch(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function loadSnapshot(): Promise<ModelInfo[]> {
  const text = await readFile(SNAPSHOT_PATH, 'utf8');
  const parsed = JSON.parse(text) as SnapshotShape;
  // Mark source as 'snapshot' so callers know it's not live.
  return parsed.data.map((m) => ({ ...m, source: 'snapshot' as const }));
}

export interface ProbeResult {
  models: ModelInfo[];
  source: 'frontend' | 'v1' | 'snapshot';
  /** Curated free model ids from src/models.ts that were NOT found free in this probe. */
  stale_curated_ids: string[];
}

/**
 * Probe OpenRouter for the model catalog. Tries frontend → v1 → snapshot in order.
 * Always returns a populated list; never throws (snapshot is the last-resort guarantee).
 */
export async function probeModels(): Promise<ProbeResult> {
  let models: ModelInfo[] = [];
  let source: ProbeResult['source'] = 'snapshot';

  try {
    const json = await tryFetch(FRONTEND_URL);
    models = parseFrontend(json);
    if (models.length > 0) source = 'frontend';
  } catch (e) {
    console.error(`[probe] /api/frontend/models failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (models.length === 0) {
    try {
      const json = await tryFetch(V1_URL);
      models = parseV1(json);
      if (models.length > 0) source = 'v1';
    } catch (e) {
      console.error(`[probe] /api/v1/models failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (models.length === 0) {
    try {
      models = await loadSnapshot();
      source = 'snapshot';
    } catch (e) {
      console.error(`[probe] snapshot load failed: ${e instanceof Error ? e.message : String(e)}`);
      // Last resort: empty list. Clients should treat this as a degraded state.
      models = [];
    }
  }

  // Compare curated free models against the live free list.
  const liveFreeIds = new Set(
    models.filter((m) => m.is_free && isTrulyFree(m.pricing)).map((m) => m.id),
  );
  const curated = curatedFreeModels();
  const stale_curated_ids: string[] = [];
  for (const id of curated) {
    if (!liveFreeIds.has(id)) stale_curated_ids.push(id);
  }

  if (stale_curated_ids.length > 0) {
    console.error(
      `[probe] Curated models no longer free (or missing from probe): ${stale_curated_ids.join(', ')}. Source: ${source}.`,
    );
  } else {
    console.error(
      `[probe] ${models.length} models, ${liveFreeIds.size} truly-free; all ${curated.size} curated entries verified. Source: ${source}.`,
    );
  }

  return { models, source, stale_curated_ids };
}

/** Filter the probe result to free models only. */
export function freeModels(probe: ProbeResult): ModelInfo[] {
  return probe.models.filter((m) => m.is_free && isTrulyFree(m.pricing));
}

/** Lookup by model id. Returns null if not found. */
export function findModel(probe: ProbeResult, id: string): ModelInfo | null {
  return probe.models.find((m) => m.id === id) ?? null;
}
