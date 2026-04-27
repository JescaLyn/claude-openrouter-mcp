/**
 * transcribe — speech-to-text via OpenRouter chat completions with an
 * `input_audio` content block.
 *
 * PAID-ONLY. No free STT model exists on OpenRouter (verified 2026-04-26).
 * Cost-confirmation flow applies to every call.
 *
 * Default model: Mistral Voxtral Small ($0.0001/min input). Multilingual
 * upgrade: google/gemini-2.5-flash-lite (~$0.018 per 10 min).
 *
 * The caller doesn't typically know audio duration without first transcribing —
 * `duration_seconds_hint` lets them surface a meaningful pre-call estimate.
 * Without a hint we default to 60s so the user sees a non-zero number.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { PAID_GENERATION_MODELS, PROVIDER_DEFAULTS } from '../models.js';
import { MAX_BASE64_BYTES } from '../security.js';
import type { ToolContext } from '../types.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const PER_CALL_TIMEOUT_MS = 60_000;

/**
 * Pricing for STT models. Voxtral and similar bill per minute of input audio.
 * Token-billed models (Gemini family) are approximated on per-minute basis
 * here using the published $0.018/10-min benchmark.
 */
interface SttRate {
  rate_per_minute: number;
  label: string;
}

function sttRate(modelId: string): SttRate {
  if (modelId === 'mistralai/voxtral-small-24b-2507') {
    return { rate_per_minute: 0.0001, label: 'Voxtral Small' };
  }
  if (modelId === 'google/gemini-2.5-flash-lite') {
    return { rate_per_minute: 0.0018, label: 'Gemini 2.5 Flash Lite (multilingual)' };
  }
  if (modelId === 'google/gemini-2.5-flash') {
    return { rate_per_minute: 0.005, label: 'Gemini 2.5 Flash' };
  }
  return { rate_per_minute: 0.0001, label: `${modelId} (unknown rate, estimated at $0.0001/min)` };
}

const FORMATS = ['wav', 'mp3', 'm4a', 'flac', 'ogg'] as const;
type AudioFormat = (typeof FORMATS)[number];

export const definition = {
  name: 'transcribe',
  description:
    "Transcribe audio to text. PAID — no free OpenRouter option for audio input. Default: Mistral Voxtral Small (per-minute billing, 10-min audio ≈ $0.001). For multilingual / harder audio set model: 'google/gemini-2.5-flash-lite' (~$0.018 per 10 min). First call without allow_paid: true returns PAID_CONFIRMATION_REQUIRED with cost computed from duration_seconds_hint (default 60s if absent). Use for: meeting notes, podcast clips, voice memos, interview audio. NOT for: live streaming transcription (latency too high), or audio with hard speaker-diarization needs (Voxtral is single-stream).",
  inputSchema: {
    type: 'object',
    properties: {
      audio: {
        type: 'string',
        description: 'Base64-encoded audio bytes (no data: prefix needed).',
      },
      format: {
        type: 'string',
        enum: ['wav', 'mp3', 'm4a', 'flac', 'ogg'],
        description: 'Audio container/encoding.',
      },
      prompt: {
        type: 'string',
        description: "Optional instruction. Default: 'Transcribe this audio verbatim.'",
        default: 'Transcribe this audio verbatim.',
      },
      language_hint: {
        type: 'string',
        description: 'Optional BCP-47 language code or English name; improves accuracy for non-English audio.',
      },
      duration_seconds_hint: {
        type: 'integer',
        description:
          'Optional duration of the audio in seconds, used only for the pre-call cost estimate (you usually don\'t know this without transcribing first). Defaults to 60s for the estimate. Real billing comes from upstream.',
      },
      model: {
        type: 'string',
        description:
          "Optional explicit model override. Default: 'mistralai/voxtral-small-24b-2507'.",
      },
      allow_paid: {
        type: 'boolean',
        description:
          'REQUIRED to actually charge. First call without this returns PAID_CONFIRMATION_REQUIRED with cost from duration_seconds_hint × per-minute rate.',
        default: false,
      },
    },
    required: ['audio', 'format'],
  },
};

const Args = z.object({
  audio: z.string().min(1).max(MAX_BASE64_BYTES, `audio data exceeds ${MAX_BASE64_BYTES} byte cap`),
  format: z.enum(FORMATS),
  prompt: z.string().default('Transcribe this audio verbatim.'),
  language_hint: z.string().optional(),
  duration_seconds_hint: z.number().int().positive().max(36_000).optional(),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

interface CostEstimate {
  cost_usd: number;
  breakdown: string;
  duration_seconds_used: number;
}

function estimateTranscribeCost(modelId: string, durationHintSeconds: number | undefined): CostEstimate {
  const duration = durationHintSeconds ?? 60;
  const rate = sttRate(modelId);
  const minutes = duration / 60;
  const cost = minutes * rate.rate_per_minute;
  const labelSource = durationHintSeconds === undefined
    ? 'default 60s estimate (provide duration_seconds_hint for accuracy)'
    : `${duration}s hinted`;
  return {
    cost_usd: Number(cost.toFixed(6)),
    breakdown: `${rate.label} · ${labelSource} · ${minutes.toFixed(2)} min × $${rate.rate_per_minute.toFixed(6)}/min = $${cost.toFixed(6)}`,
    duration_seconds_used: duration,
  };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export async function handler(rawArgs: unknown, _ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `transcribe invalid input: ${parsed.error.message}`,
        suggested_action:
          'Verify audio is a non-empty base64 string and format is one of wav/mp3/m4a/flac/ogg.',
      }),
    );
  }
  const args = parsed.data;
  const modelId = args.model ?? PAID_GENERATION_MODELS.stt_default.id;
  const estimate = estimateTranscribeCost(modelId, args.duration_seconds_hint);

  if (!args.allow_paid) {
    return toolResult(
      error({
        code: 'PAID_CONFIRMATION_REQUIRED',
        message: 'transcribe charges your OpenRouter account. Confirm before proceeding.',
        retryable: true,
        suggested_action:
          'Show the cost to the user (note: estimate uses duration_seconds_hint; actual cost depends on real audio length), get approval, then retry with allow_paid: true.',
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
    return await callTranscribeEndpoint(apiKey, modelId, args, estimate);
  } catch (e) {
    return toolResult(unknownError(e, 'transcribe'));
  }
}

async function callTranscribeEndpoint(
  apiKey: string,
  modelId: string,
  args: z.infer<typeof Args>,
  estimate: CostEstimate,
) {
  const promptText = args.language_hint
    ? `${args.prompt} (Language hint: ${args.language_hint}.)`
    : args.prompt;

  const body = {
    model: modelId,
    messages: [
      {
        role: 'user' as const,
        content: [
          { type: 'text', text: promptText },
          {
            type: 'input_audio',
            input_audio: { data: args.audio, format: args.format as AudioFormat },
          },
        ],
      },
    ],
    // Server-level provider routing — keeps user audio/transcripts off
    // prompt-logging providers per the data_collection: 'deny' policy.
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
        message: `STT model ${modelId} not found.`,
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

  let data: ChatCompletionResponse;
  try {
    data = (await res.json()) as ChatCompletionResponse;
  } catch {
    return toolResult(
      error({
        code: 'UPSTREAM_HTTP',
        message: `OpenRouter returned non-JSON response on ${modelId}.`,
        retryable: true,
        suggested_action: 'Retry; if persistent, file an issue with the model id.',
      }),
    );
  }

  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    return toolResult(
      error({
        code: 'UPSTREAM_HTTP',
        message: `Empty transcript from ${modelId}.`,
        retryable: true,
        suggested_action: 'Retry; if persistent, try the multilingual model (gemini-2.5-flash-lite).',
      }),
    );
  }

  return toolResult(
    success({
      result: {
        text: content,
        duration_seconds: estimate.duration_seconds_used,
        cost_breakdown: estimate.breakdown,
      },
      model_used: modelId,
      tokens_in: data.usage?.prompt_tokens ?? 0,
      tokens_out: data.usage?.completion_tokens ?? 0,
      finish_reason: choice?.finish_reason ?? 'stop',
      fallback_chain: [modelId],
      cost_usd: estimate.cost_usd,
    }),
  );
}
