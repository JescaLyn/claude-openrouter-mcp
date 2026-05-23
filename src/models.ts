/**
 * Per-task curated model map.
 *
 * Three layers per task: free primary → free fallback → cheap-paid escalation.
 * Paid is only reached when the caller passes allow_paid: true; otherwise the
 * client returns a PAID_CONFIRMATION_REQUIRED envelope after free fallbacks fail.
 *
 * IMPORTANT: do NOT hardcode context_length here. It comes from the live probe
 * response (see src/probe.ts) and is hand-maintained as an anti-pattern flagged
 * in the prior-art audit. We only store ids and cost annotations.
 *
 * Source data: docs/MODELS.md, verified against /api/frontend/models on 2026-05-23.
 */

import type { TaskModelChain, TaskType } from './types.js';

export const TASK_MODELS: Record<TaskType, TaskModelChain> = {
  // ── Generic ──────────────────────────────────────────────────────────────
  general: {
    free_primary: 'openai/gpt-oss-120b',
    free_fallback: 'qwen/qwen3-next-80b-a3b-instruct',
    paid_escalation: 'google/gemini-2.5-flash',
    paid_cost_note: 'gemini-2.5-flash · ~$0.0024 per 2K-in/500-out call',
  },
  reasoning: {
    free_primary: 'nvidia/nemotron-3-super-120b-a12b',
    free_fallback: 'qwen/qwen3-next-80b-a3b-instruct',
    paid_escalation: 'anthropic/claude-haiku-4-5',
    paid_cost_note: 'claude-haiku-4-5 · ~$0.0045 per 2K-in/500-out call',
  },
  creative: {
    free_primary: 'meta-llama/llama-3.3-70b-instruct',
    free_fallback: 'qwen/qwen3-next-80b-a3b-instruct',
    paid_escalation: 'google/gemini-2.5-flash',
    paid_cost_note: 'gemini-2.5-flash · ~$0.0024 per 2K-in/500-out call',
  },
  long_context: {
    free_primary: 'qwen/qwen3-next-80b-a3b-instruct',
    free_fallback: 'inclusionai/ling-2.6-flash',
    paid_escalation: 'google/gemini-2.5-flash',
    paid_cost_note: 'gemini-2.5-flash · 1M ctx · varies with input size',
  },

  // ── Code ─────────────────────────────────────────────────────────────────
  code: {
    free_primary: 'qwen/qwen3-coder',
    free_fallback: 'openai/gpt-oss-120b',
    paid_escalation: 'anthropic/claude-haiku-4-5',
    paid_cost_note: 'claude-haiku-4-5 · ~$0.0045 per 2K-in/500-out call',
  },
  commit_message: {
    free_primary: 'openai/gpt-oss-20b',
    free_fallback: 'qwen/qwen3-coder',
    paid_escalation: 'anthropic/claude-haiku-4-5',
    paid_cost_note: 'claude-haiku-4-5 · ~$0.0045 per call',
  },

  // ── Text wrappers ────────────────────────────────────────────────────────
  summarize_short: {
    free_primary: 'openai/gpt-oss-20b',
    free_fallback: 'nvidia/nemotron-nano-9b-v2',
    paid_escalation: 'google/gemini-2.5-flash-lite',
    paid_cost_note: 'gemini-2.5-flash-lite · ~$0.0006 per 2K-in/500-out call',
  },
  summarize_long: {
    free_primary: 'qwen/qwen3-next-80b-a3b-instruct',
    free_fallback: 'inclusionai/ling-2.6-flash',
    paid_escalation: 'google/gemini-2.5-flash',
    paid_cost_note: 'gemini-2.5-flash · 1M ctx · varies with input size',
  },
  extract: {
    // gpt-oss-120b advertises native structured output; verified strict json_schema support.
    free_primary: 'openai/gpt-oss-120b',
    free_fallback: 'meta-llama/llama-3.3-70b-instruct',
    paid_escalation: 'mistralai/mistral-small-3.2-24b-instruct',
    paid_cost_note: 'mistral-small-3.2 · ~$0.00025 per 2K-in/500-out call',
  },
  classify: {
    free_primary: 'nvidia/nemotron-nano-9b-v2',
    free_fallback: 'meta-llama/llama-3.2-3b-instruct',
    paid_escalation: 'openai/gpt-5-nano',
    paid_cost_note: 'gpt-5-nano · ~$0.0003 per 2K-in/500-out call',
  },
  translate: {
    free_primary: 'google/gemma-4-31b-it',
    free_fallback: 'tencent/hy3-preview',
    paid_escalation: 'google/gemini-2.5-flash',
    paid_cost_note: 'gemini-2.5-flash · ~$0.0024 per 2K-in/500-out call',
  },
  rewrite: {
    free_primary: 'qwen/qwen3-next-80b-a3b-instruct',
    free_fallback: 'meta-llama/llama-3.3-70b-instruct',
    paid_escalation: 'google/gemini-2.0-flash-001',
    paid_cost_note: 'gemini-2.0-flash · ~$0.0004 per 2K-in/500-out call',
  },

  // ── Multimodal input ─────────────────────────────────────────────────────
  extract_text: {
    // No dedicated free OCR model remains; gemma-4-31b-it is the strongest free vision model.
    free_primary: 'google/gemma-4-31b-it',
    free_fallback: 'nvidia/nemotron-nano-12b-v2-vl',
    paid_escalation: 'google/gemini-2.5-flash',
    paid_cost_note: 'gemini-2.5-flash · ~$0.0024 per call (image included)',
  },
  analyze_image: {
    free_primary: 'google/gemma-4-31b-it',
    free_fallback: 'google/gemma-4-26b-a4b-it',
    paid_escalation: 'google/gemini-2.5-flash',
    paid_cost_note: 'gemini-2.5-flash · ~$0.0024 per call (image included)',
  },
  read_pdf: {
    // Free path: any free chat model + cloudflare-ai engine via file-parser plugin.
    // The engine choice is the real lever; the model just summarizes the extracted text.
    free_primary: 'openai/gpt-oss-120b',
    free_fallback: 'qwen/qwen3-next-80b-a3b-instruct',
    paid_escalation: 'google/gemini-2.5-flash',
    paid_cost_note: 'gemini-2.5-flash + mistral-ocr ($2/1K pages) for scanned PDFs',
  },
  analyze_video: {
    free_primary: 'nvidia/nemotron-nano-12b-v2-vl',
    free_fallback: 'google/gemma-4-31b-it',
    paid_escalation: 'google/gemini-2.5-flash',
    paid_cost_note: 'gemini-2.5-flash · varies with video length',
  },
};

/** Lookup with a defensive fallback to `general` for unknown task types. */
export function chainFor(task: TaskType): TaskModelChain {
  return TASK_MODELS[task] ?? TASK_MODELS.general;
}

/**
 * Provider preferences applied to every request.
 *
 * Locked at server level — NOT exposed as per-tool params. Override only via
 * query_model.extra passthrough.
 */
export const PROVIDER_DEFAULTS = {
  sort: 'latency' as const,
  data_collection: 'deny' as const, // skip prompt-logging providers — we route code/diffs/text
  require_parameters: true, // no silent JSON-schema → json_object fallback
  allow_fallbacks: true,
};

/**
 * Cheap-paid generation models for paid-only output modalities.
 * These are NOT in the per-task chain — they're the only option for their
 * modality. Used by generate_image, generate_audio, generate_video, transcribe.
 */
export const PAID_GENERATION_MODELS = {
  image_default: {
    id: 'black-forest-labs/flux.2-klein-4b',
    cost_note: 'FLUX.2 Klein 4B · ~$0.014 per 1MP (1024×1024)',
  },
  image_quality: {
    id: 'black-forest-labs/flux.2-pro',
    cost_note: 'FLUX.2 Pro · ~$0.030 per 1MP',
  },
  tts_default: {
    id: 'openai/gpt-4o-mini-tts-2025-12-15',
    cost_note: 'GPT-4o Mini TTS · ~$0.003 per 5-min script (5K chars)',
  },
  video_default: {
    id: 'google/veo-3.1-lite',
    cost_note: 'Veo 3.1 Lite 720p · $0.03/sec · 5s = $0.15',
  },
  video_quality: {
    id: 'google/veo-3.1-fast',
    cost_note: 'Veo 3.1 Fast 1080p+audio · $0.12/sec · 5s = $0.60',
  },
  stt_default: {
    id: 'mistralai/voxtral-small-24b-2507',
    cost_note: 'Voxtral Small · ~$0.0001/min · 10 min = $0.001',
  },
  stt_multilingual: {
    id: 'google/gemini-2.5-flash-lite',
    cost_note: 'Gemini 2.5 Flash Lite · ~$0.018 per 10 min audio',
  },
} as const;

/** All curated free model ids — used by probe.ts to validate against live free list. */
export function curatedFreeModels(): Set<string> {
  const ids = new Set<string>();
  for (const chain of Object.values(TASK_MODELS)) {
    ids.add(chain.free_primary);
    ids.add(chain.free_fallback);
  }
  return ids;
}
