/**
 * generate_audio — text-to-speech via OpenRouter's dedicated audio endpoint.
 *
 * PAID-ONLY. No free TTS option exists on OpenRouter (verified 2026-04-26).
 * Cost-confirmation flow applies to every call:
 *   1. First call without `allow_paid: true` → PAID_CONFIRMATION_REQUIRED with
 *      character-based cost estimate.
 *   2. Caller surfaces cost, user approves, retry with `allow_paid: true`.
 *
 * Endpoint: `POST /api/v1/audio/speech`. Note the response body is RAW AUDIO
 * BYTES (binary), not JSON — we read it as an ArrayBuffer and base64-encode.
 *
 * Default model: GPT-4o Mini TTS (~$0.0000006/char). 5K-char script ≈ $0.003.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { PAID_GENERATION_MODELS, PROVIDER_DEFAULTS } from '../models.js';
import type { ToolContext } from '../types.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/audio/speech';
const PER_CALL_TIMEOUT_MS = 60_000;

/**
 * Per-character pricing for TTS models. Token-billed models (Gemini TTS) are
 * approximated on a per-character basis here; actual charge from OpenRouter
 * remains source of truth.
 */
const TTS_PRICING: Record<string, { rate_per_char: number; label: string }> = {
  'openai/gpt-4o-mini-tts-2025-12-15': { rate_per_char: 0.0000006, label: 'GPT-4o Mini TTS' },
  'hexgrad/kokoro-82m': { rate_per_char: 0.00000062, label: 'Kokoro 82M' },
  'mistralai/voxtral-mini-tts': { rate_per_char: 0.000016, label: 'Voxtral Mini TTS' },
  // Gemini 3.1 Flash TTS bills per-token (~$0.50/min ≈ ~$0.0001/char rough est).
  'google/gemini-3.1-flash-tts-preview': {
    rate_per_char: 0.0001,
    label: 'Gemini 3.1 Flash TTS (token-approximated)',
  },
};

/** mp3 is the universal default; pcm and wav are uncompressed alternatives. */
const FORMAT_MIME: Record<'mp3' | 'pcm' | 'wav', string> = {
  mp3: 'audio/mpeg',
  pcm: 'audio/L16',
  wav: 'audio/wav',
};

export const definition = {
  name: 'generate_audio',
  description:
    "Text-to-speech. PAID — no free option exists on OpenRouter. Default: OpenAI GPT-4o Mini TTS (~$0.0000006/char, 5-min script ≈ $0.003). First call without allow_paid: true returns PAID_CONFIRMATION_REQUIRED with character-based cost estimate. Returns base64-encoded audio bytes plus mime_type. Use for: narration of generated text, audio versions of summaries, voice prompts. NOT for: live conversational audio (latency too high for that), or precise pronunciation of proper nouns the model hasn't seen.",
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to synthesize into speech.',
      },
      voice: {
        type: 'string',
        description:
          "Voice identifier; depends on the model. OpenAI TTS supports 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'. Defaults to 'alloy'.",
        default: 'alloy',
      },
      format: {
        type: 'string',
        enum: ['mp3', 'pcm', 'wav'],
        description: "Audio format. 'mp3' (default) is compressed; 'pcm' and 'wav' are uncompressed.",
        default: 'mp3',
      },
      model: {
        type: 'string',
        description:
          "Optional explicit model override. Default: 'openai/gpt-4o-mini-tts-2025-12-15'.",
      },
      allow_paid: {
        type: 'boolean',
        description:
          'REQUIRED to actually charge. First call without this returns PAID_CONFIRMATION_REQUIRED with estimated cost based on text length.',
        default: false,
      },
    },
    required: ['text'],
  },
};

const Args = z.object({
  text: z.string().min(1),
  voice: z.string().default('alloy'),
  format: z.enum(['mp3', 'pcm', 'wav']).default('mp3'),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

interface CostEstimate {
  cost_usd: number;
  breakdown: string;
}

function estimateAudioCost(modelId: string, charCount: number): CostEstimate {
  const pricing = TTS_PRICING[modelId];
  if (!pricing) {
    // Defensive fallback at OpenAI Mini's rate so the user sees a non-zero number.
    const cost = charCount * 0.0000006;
    return {
      cost_usd: Number(cost.toFixed(6)),
      breakdown: `${modelId} · unknown pricing · estimated at $0.0000006/char × ${charCount} chars = $${cost.toFixed(6)}`,
    };
  }
  const cost = charCount * pricing.rate_per_char;
  return {
    cost_usd: Number(cost.toFixed(6)),
    breakdown: `${pricing.label} · ${charCount} chars × $${pricing.rate_per_char.toExponential(2)}/char = $${cost.toFixed(6)}`,
  };
}

export async function handler(rawArgs: unknown, _ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `generate_audio invalid input: ${parsed.error.message}`,
        suggested_action: 'Verify text is non-empty and format is one of mp3/pcm/wav.',
      }),
    );
  }
  const args = parsed.data;
  const modelId = args.model ?? PAID_GENERATION_MODELS.tts_default.id;
  const estimate = estimateAudioCost(modelId, args.text.length);

  if (!args.allow_paid) {
    return toolResult(
      error({
        code: 'PAID_CONFIRMATION_REQUIRED',
        message: 'generate_audio charges your OpenRouter account. Confirm before proceeding.',
        retryable: true,
        suggested_action: 'Show the cost to the user, get approval, then retry with allow_paid: true.',
        estimated_cost_usd: estimate.cost_usd,
        cost_breakdown: estimate.breakdown,
        suggested_paid_model: modelId,
      }),
    );
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    return toolResult(
      error({
        code: 'MISSING_CREDENTIAL',
        message: 'OPENROUTER_API_KEY is not set.',
        suggested_action: 'Set OPENROUTER_API_KEY in your .mcp.json env block.',
      }),
    );
  }

  try {
    return await callTtsEndpoint(apiKey, modelId, args, estimate);
  } catch (e) {
    return toolResult(unknownError(e, 'generate_audio'));
  }
}

async function callTtsEndpoint(
  apiKey: string,
  modelId: string,
  args: z.infer<typeof Args>,
  estimate: CostEstimate,
) {
  const body = {
    model: modelId,
    input: args.text,
    voice: args.voice,
    response_format: args.format,
    // Server-level provider routing — data_collection: 'deny' protects user
    // input text from prompt-logging providers.
    provider: PROVIDER_DEFAULTS,
  };

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return toolResult(
      error({
        code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_HTTP',
        message: `Network error calling ${modelId}: ${message}`,
        retryable: true,
        suggested_action: 'Retry once; check OpenRouter status if it persists.',
      }),
    );
  }

  if (res.status === 404) {
    return toolResult(
      error({
        code: 'MODEL_NOT_FOUND',
        message: `TTS model ${modelId} not found.`,
        retryable: false,
        suggested_action: 'Check the model id; see docs/MODELS.md for the verified list.',
      }),
    );
  }

  if (res.status === 429) {
    return toolResult(
      error({
        code: 'RATE_LIMITED',
        message: `OpenRouter rate-limited ${modelId}.`,
        retryable: true,
        suggested_action: 'Wait per Retry-After / X-RateLimit-Reset, then retry.',
      }),
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return toolResult(
      error({
        code: 'UPSTREAM_HTTP',
        message: `OpenRouter ${res.status} on ${modelId}: ${text.slice(0, 200)}`,
        retryable: res.status >= 500,
        suggested_action:
          res.status >= 500
            ? 'Retry; OpenRouter or the audio provider had a transient error.'
            : 'Inspect the request; this is a 4xx and is likely deterministic.',
      }),
    );
  }

  // Response is raw audio bytes — NOT JSON.
  let bytes: ArrayBuffer;
  try {
    bytes = await res.arrayBuffer();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return toolResult(
      error({
        code: 'UPSTREAM_HTTP',
        message: `Failed to read audio bytes from ${modelId}: ${message}`,
        retryable: true,
        suggested_action: 'Retry; if persistent, file an issue.',
      }),
    );
  }

  if (bytes.byteLength === 0) {
    return toolResult(
      error({
        code: 'UPSTREAM_HTTP',
        message: `Empty audio response from ${modelId}.`,
        retryable: true,
        suggested_action: 'Retry; consider a different voice if persistent.',
      }),
    );
  }

  const audioBase64 = Buffer.from(bytes).toString('base64');
  const mimeType = FORMAT_MIME[args.format];

  return toolResult(
    success({
      result: {
        audio_base64: audioBase64,
        mime_type: mimeType,
        cost_breakdown: estimate.breakdown,
      },
      model_used: modelId,
      tokens_in: 0,
      tokens_out: 0,
      finish_reason: 'stop',
      fallback_chain: [modelId],
      cost_usd: estimate.cost_usd,
    }),
  );
}
