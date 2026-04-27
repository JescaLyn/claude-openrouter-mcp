/**
 * list_free_models — list currently-available free models on OpenRouter.
 *
 * Useful when:
 *   - A curated model returned MODEL_NOT_FOUND (it may have been deprecated)
 *   - You want to discover newly-added free options
 *   - You're picking a model for query_model and need a current id
 *
 * Reads from the cached probe by default. Pass refresh: true to re-probe live.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { freeModels, probeModels, type ProbeResult } from '../probe.js';
import type { ToolContext } from '../types.js';

export const definition = {
  name: 'list_free_models',
  description:
    "List currently-available free OpenRouter models, grouped by capability. Useful when a curated model returns MODEL_NOT_FOUND, or to discover newly-added free options. Filter by `category` (text, vision, long_context) or pass `refresh: true` to re-probe the live API instead of using the cached probe.",
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['all', 'text', 'vision', 'long_context'],
        description:
          'Filter by capability. `text` = text-out only. `vision` = accepts image input. `long_context` = ≥200K context. Defaults to `all`.',
        default: 'all',
      },
      refresh: {
        type: 'boolean',
        description: 'Force a fresh probe instead of using the cached result. Defaults to false.',
        default: false,
      },
    },
  },
};

const Args = z.object({
  category: z.enum(['all', 'text', 'vision', 'long_context']).default('all'),
  refresh: z.boolean().default(false),
});

// Module-scope cache. Populated lazily on first call; refreshed on `refresh: true`.
// (This is a deliberate exception to "no module globals" — the cache is read-only
// from the tool's perspective, refreshed via the explicit refresh flag.)
let cached: ProbeResult | null = null;

export async function handler(rawArgs: unknown, _ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `list_free_models invalid input: ${parsed.error.message}`,
        suggested_action: 'category must be one of: all, text, vision, long_context.',
      }),
    );
  }
  const args = parsed.data;

  try {
    if (args.refresh || !cached) {
      cached = await probeModels();
    }
    const probe = cached;
    let models = freeModels(probe);

    if (args.category === 'text') {
      models = models.filter(
        (m) =>
          m.output_modalities.includes('text') &&
          // pure text-out (exclude image-in vision-only models for the "text" category)
          (m.input_modalities.length === 0 || m.input_modalities.every((mod) => mod === 'text')),
      );
    } else if (args.category === 'vision') {
      models = models.filter(
        (m) => m.input_modalities.includes('image') && m.output_modalities.includes('text'),
      );
    } else if (args.category === 'long_context') {
      models = models.filter((m) => m.context_length >= 200_000);
    }

    const result = {
      probed_at: new Date().toISOString(),
      source: probe.source,
      category: args.category,
      count: models.length,
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        context_length: m.context_length,
        input_modalities: m.input_modalities,
        output_modalities: m.output_modalities,
      })),
      stale_curated_ids: probe.stale_curated_ids,
    };

    return toolResult(
      success({
        result,
        model_used: 'probe',
        finish_reason: 'stop',
      }),
    );
  } catch (e) {
    return toolResult(unknownError(e, 'list_free_models'));
  }
}
