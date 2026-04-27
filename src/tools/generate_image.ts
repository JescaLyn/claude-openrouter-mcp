/**
 * generate_image — text-to-image via OpenRouter chat completions with
 * `modalities: ["image", "text"]`.
 *
 * PAID-ONLY. There is no free image-generation model on OpenRouter (verified
 * 2026-04-26). Every call requires the cost-confirmation flow:
 *   1. First call without `allow_paid: true` → returns PAID_CONFIRMATION_REQUIRED
 *      with the estimated cost so the caller can surface it to the user.
 *   2. User approves; caller retries with `allow_paid: true` → real upstream call.
 *
 * Defaults: FLUX.2 Klein 4B at 1024×1024 (~$0.014 per image). Quality upgrade
 * is `black-forest-labs/flux.2-pro` (~$0.030/MP). See docs/MODELS.md for the
 * full pricing table.
 *
 * The OpenRouter response embeds the image as a data URL at
 *   choices[0].message.images[0].image_url.url
 * formatted like `data:image/png;base64,...`. We strip the `data:` prefix and
 * return raw base64 in `image_base64`, with `mime_type` carrying the type.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { PAID_GENERATION_MODELS, PROVIDER_DEFAULTS } from '../models.js';
import { MAX_BASE64_BYTES, validateUserUrl } from '../security.js';
import type { ToolContext } from '../types.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const PER_CALL_TIMEOUT_MS = 60_000;

/**
 * Pricing table for image-generation models.
 *
 * Two billing shapes:
 *   - per-MP — FLUX family (`mp` mode). Cost = MP × rate.
 *   - flat per-image — Gemini, Seedream, Riverflow (`flat` mode). Cost = rate.
 *
 * Unknown models surface as `unknown` and get a defensive ~$0.10 estimate so
 * the user sees a non-zero number; the real charge comes from OpenRouter.
 */
const IMAGE_PRICING: Record<
  string,
  { mode: 'mp' | 'flat'; rate: number; label: string }
> = {
  'black-forest-labs/flux.2-klein-4b': { mode: 'mp', rate: 0.014, label: 'FLUX.2 Klein 4B' },
  'black-forest-labs/flux.2-pro': { mode: 'mp', rate: 0.030, label: 'FLUX.2 Pro' },
  'black-forest-labs/flux.2-max': { mode: 'mp', rate: 0.07, label: 'FLUX.2 Max' },
  'black-forest-labs/flux.2-flex': { mode: 'mp', rate: 0.06, label: 'FLUX.2 Flex' },
  'google/gemini-2.5-flash-image': { mode: 'flat', rate: 0.030, label: 'Gemini 2.5 Flash Image' },
  'google/gemini-3-pro-image-preview': { mode: 'flat', rate: 0.12, label: 'Gemini 3 Pro Image' },
  'bytedance-seed/seedream-4.5': { mode: 'flat', rate: 0.04, label: 'ByteDance Seedream 4.5' },
  'sourceful/riverflow-v2-fast': { mode: 'flat', rate: 0.02, label: 'Riverflow V2 Fast' },
  'sourceful/riverflow-v2-pro': { mode: 'flat', rate: 0.15, label: 'Riverflow V2 Pro' },
};

/** Megapixels per `size` enum value. 1K = 1024×1024 = ~1.05MP. */
const SIZE_MP: Record<'1K' | '2K' | '4K', number> = {
  '1K': 1.05,
  '2K': 4.2,
  '4K': 16.8,
};

const SIZE_LABEL: Record<'1K' | '2K' | '4K', string> = {
  '1K': '1024×1024',
  '2K': '2048×2048',
  '4K': '4096×4096',
};

export const definition = {
  name: 'generate_image',
  description:
    'Generate an image from a text prompt. PAID — no free option exists on OpenRouter. Default: FLUX.2 Klein 4B (~$0.014 for 1024×1024). Set model: \'black-forest-labs/flux.2-pro\' for higher quality (~$0.030/MP). First call without allow_paid: true returns PAID_CONFIRMATION_REQUIRED with the estimated cost; surface to user, get approval, then retry with allow_paid: true. Returns base64-encoded image bytes plus mime_type. Use for: generating illustrations, mockups, hero images, social posts. NOT for: edits to existing photos at pixel level (use a dedicated image-editor), or content where exact text rendering matters (FLUX text rendering is better than most but still imperfect).',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The text prompt describing the image to generate.',
      },
      size: {
        type: 'string',
        enum: ['1K', '2K', '4K'],
        description:
          "Approximate output dimension. '1K' = 1024×1024 (~1MP, default), '2K' = 2048×2048 (~4MP), '4K' = 4096×4096 (~16.8MP). Per-MP-priced models scale linearly; flat-per-image models charge the same regardless of size.",
        default: '1K',
      },
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '16:9', '9:16', '4:3'],
        description: 'Aspect ratio of the output. Default 1:1 (square).',
        default: '1:1',
      },
      reference_image: {
        type: 'string',
        description:
          'Optional URL or data URL for image-to-image generation (style transfer, edits). Not all models support this; FLUX family does.',
      },
      model: {
        type: 'string',
        description:
          "Optional explicit model override. Default: 'black-forest-labs/flux.2-klein-4b'. Quality upgrade: 'black-forest-labs/flux.2-pro'.",
      },
      allow_paid: {
        type: 'boolean',
        description:
          'REQUIRED to actually charge. First call without this returns PAID_CONFIRMATION_REQUIRED with estimated cost. Caller surfaces cost to user, user approves, caller retries with allow_paid: true.',
        default: false,
      },
    },
    required: ['prompt'],
  },
};

const Args = z.object({
  prompt: z.string().min(1),
  size: z.enum(['1K', '2K', '4K']).default('1K'),
  aspect_ratio: z.enum(['1:1', '16:9', '9:16', '4:3']).default('1:1'),
  reference_image: z
    .string()
    .max(MAX_BASE64_BYTES, `reference_image exceeds ${MAX_BASE64_BYTES} byte cap`)
    .refine((s) => validateUserUrl(s).ok, (s) => ({
      message: validateUserUrl(s).reason ?? 'reference_image URL rejected',
    }))
    .optional(),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

interface CostEstimate {
  cost_usd: number;
  breakdown: string;
}

function estimateImageCost(modelId: string, size: '1K' | '2K' | '4K'): CostEstimate {
  const pricing = IMAGE_PRICING[modelId];
  if (!pricing) {
    return {
      cost_usd: 0.10,
      breakdown: `${modelId} · unknown pricing · defensive estimate ~$0.10 (actual charge from OpenRouter)`,
    };
  }
  if (pricing.mode === 'flat') {
    return {
      cost_usd: pricing.rate,
      breakdown: `${pricing.label} · flat $${pricing.rate.toFixed(3)}/image (size ignored for billing)`,
    };
  }
  const mp = SIZE_MP[size];
  const cost = mp * pricing.rate;
  return {
    cost_usd: Number(cost.toFixed(4)),
    breakdown: `${pricing.label} · ${SIZE_LABEL[size]} · ${mp}MP × $${pricing.rate.toFixed(3)}/MP = $${cost.toFixed(4)}`,
  };
}

interface ImageResponse {
  choices?: Array<{
    message?: {
      content?: string;
      images?: Array<{
        type?: string;
        image_url?: { url?: string };
      }>;
    };
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
        message: `generate_image invalid input: ${parsed.error.message}`,
        suggested_action: 'Verify prompt is non-empty and size/aspect_ratio are valid enum values.',
      }),
    );
  }
  const args = parsed.data;
  const modelId = args.model ?? PAID_GENERATION_MODELS.image_default.id;
  const estimate = estimateImageCost(modelId, args.size);

  if (!args.allow_paid) {
    return toolResult(
      error({
        code: 'PAID_CONFIRMATION_REQUIRED',
        message: 'generate_image charges your OpenRouter account. Confirm before proceeding.',
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
    return await callImageEndpoint(apiKey, modelId, args, estimate);
  } catch (e) {
    return toolResult(unknownError(e, 'generate_image'));
  }
}

async function callImageEndpoint(
  apiKey: string,
  modelId: string,
  args: z.infer<typeof Args>,
  estimate: CostEstimate,
) {
  // Build the user content. If a reference image is supplied, switch to a
  // multipart content array so the model sees both prompt and image.
  const userContent: string | Array<unknown> = args.reference_image
    ? [
        { type: 'text', text: args.prompt },
        { type: 'image_url', image_url: { url: args.reference_image } },
      ]
    : args.prompt;

  const body = {
    model: modelId,
    modalities: ['image', 'text'],
    messages: [{ role: 'user', content: userContent }],
    image_config: {
      aspect_ratio: args.aspect_ratio,
      image_size: args.size,
    },
    // Apply server-level provider routing — same defaults as OpenRouterClient.
    // data_collection: 'deny' is critical: user prompts may carry sensitive
    // content and must NOT flow to providers that retain prompts for training.
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
        message: `Image model ${modelId} not found.`,
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
            ? 'Retry; OpenRouter or the image provider had a transient error.'
            : 'Inspect the request; this is a 4xx and is likely deterministic.',
      }),
    );
  }

  let data: ImageResponse;
  try {
    data = (await res.json()) as ImageResponse;
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

  const imageEntry = data.choices?.[0]?.message?.images?.[0];
  const dataUrl = imageEntry?.image_url?.url;
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
    return toolResult(
      error({
        code: 'UPSTREAM_HTTP',
        message: `Image response from ${modelId} did not include an image_url.`,
        retryable: true,
        suggested_action: 'Retry; consider the quality model (flux.2-pro) if persistent.',
      }),
    );
  }

  // Parse `data:image/png;base64,...` → mime_type + raw base64.
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  let mimeType = 'image/png';
  let imageBase64 = dataUrl;
  if (match && match[1] && match[2]) {
    mimeType = match[1];
    imageBase64 = match[2];
  }

  return toolResult(
    success({
      result: {
        image_base64: imageBase64,
        mime_type: mimeType,
        cost_breakdown: estimate.breakdown,
      },
      model_used: modelId,
      tokens_in: data.usage?.prompt_tokens ?? 0,
      tokens_out: data.usage?.completion_tokens ?? 0,
      finish_reason: data.choices?.[0]?.finish_reason ?? 'stop',
      fallback_chain: [modelId],
      cost_usd: estimate.cost_usd,
    }),
  );
}
