/**
 * generate_video — text-to-video via OpenRouter's async videos endpoint.
 *
 * PAID-ONLY. Cost-confirmation flow applies to every call.
 *
 * Two-step async lifecycle:
 *   1. POST /api/v1/videos { model, prompt, ... } → 202 { id, polling_url, status }
 *   2. GET /api/v1/videos/{id} every 5s until status === 'completed' or
 *      'failed', or `poll_timeout_seconds` elapses.
 *
 * On timeout we surface UPSTREAM_TIMEOUT WITH the polling URL so the caller
 * can poll later — important because video billing already happened upstream
 * once the job was accepted.
 *
 * Default model: Veo 3.1 Lite, 720p, no audio (~$0.03/sec, 5s = $0.15).
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { PAID_GENERATION_MODELS } from '../models.js';
import type { ToolContext } from '../types.js';

const POST_ENDPOINT = 'https://openrouter.ai/api/v1/videos';
const PER_FETCH_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;

/**
 * Per-second pricing keyed by (model, resolution, with_audio). All values in
 * USD per second of generated video. Source: docs/MODELS.md "Video generation".
 */
interface VideoRate {
  rate_per_sec: number;
  label: string;
}

function videoRate(modelId: string, resolution: '720p' | '1080p', withAudio: boolean): VideoRate {
  // Veo 3.1 Lite — 720p only, base $0.03/sec; +$0.07/sec premium when audio is on.
  if (modelId === 'google/veo-3.1-lite') {
    if (withAudio) return { rate_per_sec: 0.10, label: 'Veo 3.1 Lite + audio' };
    return { rate_per_sec: 0.03, label: 'Veo 3.1 Lite 720p' };
  }
  // Veo 3.1 Fast — $0.10/sec at 720p+audio, $0.12/sec at 1080p+audio.
  if (modelId === 'google/veo-3.1-fast') {
    if (resolution === '1080p') return { rate_per_sec: 0.12, label: 'Veo 3.1 Fast 1080p+audio' };
    return { rate_per_sec: 0.10, label: 'Veo 3.1 Fast 720p+audio' };
  }
  // Veo 3.1 standard — flat $0.40/sec.
  if (modelId === 'google/veo-3.1') {
    return { rate_per_sec: 0.40, label: 'Veo 3.1 1080p+audio' };
  }
  // Seedance 2.0 — flat $0.34/sec.
  if (modelId === 'bytedance/seedance-2.0') {
    return { rate_per_sec: 0.34, label: 'Seedance 2.0' };
  }
  // Unknown model — defensive estimate at the lite rate.
  return { rate_per_sec: 0.03, label: `${modelId} (unknown rate, estimated at $0.03/sec)` };
}

export const definition = {
  name: 'generate_video',
  description:
    "Generate a short video clip from a text prompt. PAID, async — internally posts to /api/v1/videos and polls every 5s until completion. Default: Veo 3.1 Lite, 720p, 5 seconds, no audio (~$0.15). Set with_audio: true and resolution: '1080p' for synced-audio higher fidelity at higher cost. First call without allow_paid: true returns PAID_CONFIRMATION_REQUIRED with cost from duration_seconds × per-second rate. On timeout returns UPSTREAM_TIMEOUT with the polling URL so the caller can poll later. Use for: short product demos, social-media clips, concept animations. NOT for: long-form content (>15s) or content requiring exact storyboard control.",
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The text prompt describing the video to generate.',
      },
      duration_seconds: {
        type: 'integer',
        description: 'Clip length in seconds. Most models cap at 5–10s.',
        default: 5,
      },
      resolution: {
        type: 'string',
        enum: ['720p', '1080p'],
        description: 'Output resolution. 720p is the default; 1080p costs more on most models.',
        default: '720p',
      },
      aspect_ratio: {
        type: 'string',
        enum: ['16:9', '9:16', '1:1'],
        description: 'Aspect ratio. 16:9 is landscape (default), 9:16 is portrait, 1:1 is square.',
        default: '16:9',
      },
      with_audio: {
        type: 'boolean',
        description: 'Include synced audio. Adds significant per-second cost on most models.',
        default: false,
      },
      model: {
        type: 'string',
        description:
          "Optional explicit model override. Default: 'google/veo-3.1-lite'. See docs/MODELS.md for the price table.",
      },
      poll_timeout_seconds: {
        type: 'integer',
        description: 'How long to poll before returning UPSTREAM_TIMEOUT (with polling URL). Default 300.',
        default: 300,
      },
      allow_paid: {
        type: 'boolean',
        description:
          'REQUIRED to actually charge. First call without this returns PAID_CONFIRMATION_REQUIRED with cost from duration × per-second rate.',
        default: false,
      },
    },
    required: ['prompt'],
  },
};

const Args = z.object({
  prompt: z.string().min(1),
  duration_seconds: z.number().int().positive().max(60).default(5),
  resolution: z.enum(['720p', '1080p']).default('720p'),
  aspect_ratio: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
  with_audio: z.boolean().default(false),
  model: z.string().optional(),
  poll_timeout_seconds: z.number().int().positive().max(1800).default(300),
  allow_paid: z.boolean().default(false),
});

interface CostEstimate {
  cost_usd: number;
  breakdown: string;
}

function estimateVideoCost(
  modelId: string,
  duration: number,
  resolution: '720p' | '1080p',
  withAudio: boolean,
): CostEstimate {
  const rate = videoRate(modelId, resolution, withAudio);
  const cost = duration * rate.rate_per_sec;
  const audioFlag = withAudio ? ' + audio' : '';
  return {
    cost_usd: Number(cost.toFixed(4)),
    breakdown: `${rate.label} · ${resolution}${audioFlag} · ${duration}s × $${rate.rate_per_sec.toFixed(3)}/sec = $${cost.toFixed(4)}`,
  };
}

interface VideoCreateResponse {
  id?: string;
  polling_url?: string;
  status?: string;
}

interface VideoStatusResponse {
  id?: string;
  status?: 'pending' | 'running' | 'completed' | 'failed' | string;
  unsigned_urls?: string[];
  error?: { message?: string };
}

export async function handler(rawArgs: unknown, _ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `generate_video invalid input: ${parsed.error.message}`,
        suggested_action: 'Verify prompt is non-empty and duration_seconds is a positive integer.',
      }),
    );
  }
  const args = parsed.data;
  const modelId = args.model ?? PAID_GENERATION_MODELS.video_default.id;
  const estimate = estimateVideoCost(modelId, args.duration_seconds, args.resolution, args.with_audio);

  if (!args.allow_paid) {
    return toolResult(
      error({
        code: 'PAID_CONFIRMATION_REQUIRED',
        message: 'generate_video charges your OpenRouter account. Confirm before proceeding.',
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
    return await runVideoJob(apiKey, modelId, args, estimate);
  } catch (e) {
    return toolResult(unknownError(e, 'generate_video'));
  }
}

async function runVideoJob(
  apiKey: string,
  modelId: string,
  args: z.infer<typeof Args>,
  estimate: CostEstimate,
) {
  // ── Step 1: kick off the job ──────────────────────────────────────────────
  const createBody = {
    model: modelId,
    prompt: args.prompt,
    duration: args.duration_seconds,
    resolution: args.resolution,
    aspect_ratio: args.aspect_ratio,
    generate_audio: args.with_audio,
  };

  let createRes: Response;
  try {
    createRes = await fetch(POST_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(createBody),
      signal: AbortSignal.timeout(PER_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return toolResult(
      error({
        code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_HTTP',
        message: `Network error creating video job on ${modelId}: ${message}`,
        retryable: true,
        suggested_action: 'Retry once; check OpenRouter status if it persists.',
      }),
    );
  }

  if (createRes.status === 404) {
    return toolResult(
      error({
        code: 'MODEL_NOT_FOUND',
        message: `Video model ${modelId} not found.`,
        retryable: false,
        suggested_action: 'Check the model id; see docs/MODELS.md for the verified list.',
      }),
    );
  }

  if (createRes.status === 429) {
    return toolResult(
      error({
        code: 'RATE_LIMITED',
        message: `OpenRouter rate-limited ${modelId}.`,
        retryable: true,
        suggested_action: 'Wait per Retry-After / X-RateLimit-Reset, then retry.',
      }),
    );
  }

  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '');
    return toolResult(
      error({
        code: 'UPSTREAM_HTTP',
        message: `OpenRouter ${createRes.status} creating video job on ${modelId}: ${text.slice(0, 200)}`,
        retryable: createRes.status >= 500,
        suggested_action:
          createRes.status >= 500
            ? 'Retry; OpenRouter or the video provider had a transient error.'
            : 'Inspect the request; this is a 4xx and is likely deterministic.',
      }),
    );
  }

  let createData: VideoCreateResponse;
  try {
    createData = (await createRes.json()) as VideoCreateResponse;
  } catch {
    return toolResult(
      error({
        code: 'UPSTREAM_HTTP',
        message: `OpenRouter returned non-JSON response on video create for ${modelId}.`,
        retryable: true,
        suggested_action: 'Retry; if persistent, file an issue with the model id.',
      }),
    );
  }

  const jobId = createData.id;
  if (!jobId) {
    return toolResult(
      error({
        code: 'UPSTREAM_HTTP',
        message: `Video create response from ${modelId} had no job id.`,
        retryable: true,
        suggested_action: 'Retry; if persistent, file an issue.',
      }),
    );
  }

  const pollingUrl = createData.polling_url ?? `${POST_ENDPOINT}/${jobId}`;

  // ── Step 2: poll for completion ───────────────────────────────────────────
  const deadline = Date.now() + args.poll_timeout_seconds * 1000;
  let lastStatus: string = createData.status ?? 'pending';

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let pollRes: Response;
    try {
      pollRes = await fetch(pollingUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(PER_FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      // Transient poll failure — try again on the next tick rather than aborting
      // the whole job (the upstream charge may already have landed).
      const message = e instanceof Error ? e.message : String(e);
      lastStatus = `poll_error:${message}`;
      continue;
    }

    if (!pollRes.ok) {
      // Non-OK poll: log via lastStatus and retry next tick. Persistent failure
      // will eventually hit the deadline and return UPSTREAM_TIMEOUT below.
      lastStatus = `poll_http_${pollRes.status}`;
      continue;
    }

    let pollData: VideoStatusResponse;
    try {
      pollData = (await pollRes.json()) as VideoStatusResponse;
    } catch {
      lastStatus = 'poll_non_json';
      continue;
    }

    lastStatus = pollData.status ?? 'unknown';

    if (pollData.status === 'completed') {
      const url = pollData.unsigned_urls?.[0];
      if (!url) {
        return toolResult(
          error({
            code: 'UPSTREAM_HTTP',
            message: `Video job ${jobId} completed but unsigned_urls was empty.`,
            retryable: false,
            suggested_action: `Inspect the job manually via ${pollingUrl}.`,
          }),
        );
      }
      return toolResult(
        success({
          result: {
            video_url: url,
            duration_seconds: args.duration_seconds,
            cost_breakdown: estimate.breakdown,
            job_id: jobId,
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

    if (pollData.status === 'failed') {
      const upstreamMsg = pollData.error?.message ?? 'no detail provided';
      return toolResult(
        error({
          code: 'UPSTREAM_HTTP',
          message: `Video job ${jobId} failed on ${modelId}: ${upstreamMsg}`,
          retryable: true,
          suggested_action:
            'Retry with a revised prompt; some prompts are rejected for content policy reasons.',
        }),
      );
    }
    // pending / running / unknown — keep polling.
  }

  // Deadline hit. Surface UPSTREAM_TIMEOUT with the polling URL so the caller
  // can poll later — billing has already happened on upstream.
  return toolResult(
    error({
      code: 'UPSTREAM_TIMEOUT',
      message: `Video job ${jobId} did not complete within ${args.poll_timeout_seconds}s (last status: ${lastStatus}). Job is still running upstream and may complete; poll the URL manually.`,
      retryable: true,
      suggested_action: `GET ${pollingUrl} with your bearer token to check status; on completed, read unsigned_urls[0].`,
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
