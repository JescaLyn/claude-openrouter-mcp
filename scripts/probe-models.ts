#!/usr/bin/env tsx
/**
 * npm run probe:models
 *
 * Hits OpenRouter's live model catalog, prints a diff between the curated
 * map in src/models.ts and the actually-free live models, and writes a fresh
 * snapshot to src/models.snapshot.json (the offline fallback).
 *
 * Run this whenever curated models start failing or the free tier shifts.
 * See docs/MODELS.md "How to Refresh" for the full procedure.
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { freeModels, isTrulyFree, probeModels } from '../src/probe.js';
import { curatedFreeModels } from '../src/models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SNAPSHOT_PATH = join(__dirname, '..', 'src', 'models.snapshot.json');

async function main() {
  const probe = await probeModels();
  const free = freeModels(probe);

  console.log('');
  console.log(`Source: ${probe.source}`);
  console.log(`Total models with live endpoints: ${probe.models.length}`);
  console.log(`Truly-free (all 6 pricing fields zero): ${free.length}`);
  console.log('');

  // Diff curated map against live free list.
  const curated = curatedFreeModels();
  const liveFreeIds = new Set(free.map((m) => m.id));

  const stale = [...curated].filter((id) => !liveFreeIds.has(id));
  const verified = [...curated].filter((id) => liveFreeIds.has(id));

  console.log(`Curated free models: ${curated.size}`);
  console.log(`  Verified live: ${verified.length}`);
  if (stale.length > 0) {
    console.log(`  STALE (no longer free or missing endpoint):`);
    for (const id of stale) console.log(`    - ${id}`);
    console.log('');
    console.log('Action: update src/models.ts to use a different free model for these tasks.');
    console.log('See docs/MODELS.md for the per-task curated map.');
  } else {
    console.log('  No stale entries.');
  }
  console.log('');

  // Free models NOT in our curated map — newly added options worth considering.
  const curatedSet = new Set(curated);
  const newFree = free.filter((m) => !curatedSet.has(m.id));
  if (newFree.length > 0) {
    console.log(`Free models NOT in curated map (consider for tasks):`);
    for (const m of newFree.slice(0, 10)) {
      console.log(
        `  - ${m.id}  (${m.context_length} ctx, in: ${m.input_modalities.join('+')}, out: ${m.output_modalities.join('+')})`,
      );
    }
    if (newFree.length > 10) console.log(`  ... and ${newFree.length - 10} more`);
  }
  console.log('');

  // Refresh the snapshot file when the live source returned data.
  if (probe.source === 'frontend' || probe.source === 'v1') {
    const snapshot = {
      probed_at: new Date().toISOString(),
      source: probe.source,
      total: probe.models.length,
      data: probe.models.map((m) => ({
        id: m.id,
        name: m.name,
        context_length: m.context_length,
        input_modalities: m.input_modalities,
        output_modalities: m.output_modalities,
        is_free: m.is_free && isTrulyFree(m.pricing),
        pricing: m.pricing,
      })),
    };
    await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
    console.log(`Wrote snapshot: ${SNAPSHOT_PATH} (${snapshot.total} models)`);
  } else {
    console.log('Live probe failed; snapshot not refreshed.');
  }
}

main().catch((e) => {
  console.error('probe-models failed:', e);
  process.exit(1);
});
