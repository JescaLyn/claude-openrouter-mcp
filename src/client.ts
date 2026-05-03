/**
 * OpenRouterClient — three-tier fallback, retry on 429, paid-confirmation gate.
 *
 * Per docs/PLAN.md "Architecture":
 *   - DI'd into tool handlers (NOT a module-level singleton).
 *   - AbortSignal.timeout(60_000) per fetch.
 *   - Honor BOTH Retry-After (HTTP standard, seconds) AND X-RateLimit-Reset
 *     (OpenRouter-specific, epoch ms). Sleep + single retry; if either says
 *     wait > 60s, fail fast with RATE_LIMITED.
 *   - Three-tier per call: free primary → free fallback → cheap-paid (only if
 *     allow_paid: true) → surfaced error.
 *   - Iteration cap: max 3 model attempts per call.
 *   - Provider routing defaults locked server-level; override only via
 *     query_model.extra passthrough.
 */

import type {
  ChatRequest,
  ErrorEnvelope,
  ProviderPreferences,
  TaskModelChain,
} from './types.js';
import { error as errEnv } from './envelope.js';
import { PROVIDER_DEFAULTS } from './models.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const PER_CALL_TIMEOUT_MS = 60_000;
const MAX_RETRY_WAIT_MS = 60_000; // beyond this, fail fast on 429
const MAX_ATTEMPTS = 3; // iteration cap (free 1° + free 2° + paid)

export type ClientResult =
  | {
      ok: true;
      content: string;
      model_used: string;
      tokens_in: number;
      tokens_out: number;
      finish_reason: string;
      fallback_chain: string[];
      cost_usd: number;
    }
  | { ok: false; envelope: ErrorEnvelope; fallback_chain: string[] };

export interface ChatOptions {
  /** Pre-composed chat messages. */
  messages: ChatRequest['messages'];
  max_tokens?: number;
  temperature?: number;
  response_format?: ChatRequest['response_format'];
  /** Splatted into the request body. Useful for OpenRouter-specific fields. */
  extra?: Record<string, unknown>;
  /** Per-call provider override (rare; usually leave at PROVIDER_DEFAULTS). */
  provider?: ProviderPreferences;
}

export interface ChainOptions extends ChatOptions {
  chain: TaskModelChain;
  allow_paid?: boolean;
}

export interface DirectOptions extends ChatOptions {
  model: string;
  allow_paid?: boolean;
  /** When false, do not attempt paid even if the model is paid (still subject to allow_paid). */
}

export class OpenRouterClient {
  private readonly apiKey: string;

  constructor(opts: { apiKey: string }) {
    this.apiKey = opts.apiKey;
  }

  /**
   * Walk a task chain (free 1° → free 2° → paid). Returns on first success or
   * structured error after all attempts exhausted.
   */
  async chatChain(opts: ChainOptions): Promise<ClientResult> {
    const { chain, allow_paid = false, ...rest } = opts;

    const attempts: Array<{ model: string; paid: boolean }> = [
      { model: chain.free_primary, paid: false },
      { model: chain.free_fallback, paid: false },
    ];

    if (allow_paid) {
      attempts.push({ model: chain.paid_escalation, paid: true });
    }

    const fallback_chain: string[] = [];
    let lastError: ErrorEnvelope['error'] | null = null;

    for (const attempt of attempts) {
      fallback_chain.push(attempt.model);
      const result = await this.callModelWith429Retry({
        model: attempt.model,
        ...rest,
      });
      if (result.ok) {
        // Cost is non-zero only when we actually called a paid model.
        const cost_usd = attempt.paid ? estimateCost(attempt.model, result.tokens_in, result.tokens_out) : 0;
        return {
          ok: true,
          content: result.content,
          model_used: attempt.model,
          tokens_in: result.tokens_in,
          tokens_out: result.tokens_out,
          finish_reason: result.finish_reason,
          fallback_chain,
          cost_usd,
        };
      }
      lastError = result.error;
      // Don't retry on PAID_CONFIRMATION_REQUIRED-shaped non-errors (we don't emit those here).
      // Bail on INVALID_INPUT or MISSING_CREDENTIAL — not retryable.
      if (result.error.code === 'INVALID_INPUT' || result.error.code === 'MISSING_CREDENTIAL') {
        return { ok: false, envelope: { error: result.error }, fallback_chain };
      }
    }

    // All attempts exhausted. If we never tried paid (allow_paid=false), surface
    // PAID_CONFIRMATION_REQUIRED so the caller can re-invoke with allow_paid: true.
    if (!allow_paid) {
      return {
        ok: false,
        envelope: errEnv({
          code: 'PAID_CONFIRMATION_REQUIRED',
          message: `Free models exhausted: tried ${chain.free_primary} and ${chain.free_fallback}. Paid escalation requires explicit approval.`,
          retryable: true,
          suggested_action: `Retry with allow_paid: true to use ${chain.paid_escalation}.`,
          cost_breakdown: chain.paid_cost_note,
          suggested_paid_model: chain.paid_escalation,
        }),
        fallback_chain,
      };
    }

    // Paid was allowed and still failed. Surface the underlying error.
    return {
      ok: false,
      envelope: { error: lastError ?? freeExhaustedError(chain) },
      fallback_chain,
    };
  }

  /**
   * Direct call to a single model — used by query_model when the caller
   * explicitly picks the model. Still applies 429 retry but NO chain fallback.
   */
  async chatDirect(opts: DirectOptions): Promise<ClientResult> {
    const { model, allow_paid = false, ...rest } = opts;
    const result = await this.callModelWith429Retry({ model, ...rest });
    if (result.ok) {
      // We don't know if this model is paid without a probe lookup; be conservative.
      // Tools that care about cost should use chatChain() and pass paid_cost_note.
      return {
        ok: true,
        content: result.content,
        model_used: model,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        finish_reason: result.finish_reason,
        fallback_chain: [model],
        cost_usd: 0, // unknown; chatChain provides this when the chain is followed
      };
    }
    return {
      ok: false,
      envelope: { error: result.error },
      fallback_chain: [model],
    };
  }

  // ── Internal: single model with 429 retry ──────────────────────────────────

  private async callModelWith429Retry(opts: ChatOptions & { model: string }) {
    const first = await this.callOnce(opts);
    if (first.ok) return first;
    if (first.error.code !== 'RATE_LIMITED') return first;

    // Honor Retry-After / X-RateLimit-Reset. The error fields carry the wait hint.
    const waitMs = (first as RateLimitedFailure).retry_after_ms ?? 0;
    if (waitMs <= 0 || waitMs > MAX_RETRY_WAIT_MS) {
      // Fail fast; not worth blocking the caller for > 60s.
      return first;
    }
    await sleep(waitMs);
    return this.callOnce(opts);
  }

  // ── Internal: single fetch, no retry ───────────────────────────────────────

  private async callOnce(
    opts: ChatOptions & { model: string },
  ): Promise<CallOnceResult> {
    // Provider preferences are server-level and locked: data_collection: 'deny'
    // protects user code/diffs/text from prompt-logging providers. The merge
    // order below ensures `extra` cannot override that lock — `provider` is
    // re-spread AFTER `extra` so the server-level defaults win on conflict.
    // Per-call legitimate overrides (rare) come through opts.provider.
    const body: ChatRequest = {
      model: opts.model,
      messages: opts.messages,
      ...(opts.max_tokens !== undefined && { max_tokens: opts.max_tokens }),
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.response_format && { response_format: opts.response_format }),
      ...(opts.extra ?? {}),
      provider: { ...PROVIDER_DEFAULTS, ...opts.provider },
    };

    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isTimeout =
        e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return {
        ok: false,
        error: {
          code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_HTTP',
          message: `Network error calling ${opts.model}: ${message}`,
          retryable: true,
          suggested_action: 'Retry once; check OpenRouter status if it persists.',
        },
      };
    }

    if (res.status === 429) {
      return {
        ok: false,
        retry_after_ms: parseRetryAfterMs(res.headers),
        error: {
          code: 'RATE_LIMITED',
          message: `OpenRouter rate-limited model ${opts.model}.`,
          retryable: true,
          suggested_action: 'Wait per Retry-After / X-RateLimit-Reset, then retry.',
        },
      };
    }

    if (res.status === 404) {
      return {
        ok: false,
        error: {
          code: 'MODEL_NOT_FOUND',
          message: `Model ${opts.model} not found or no live endpoint.`,
          retryable: false,
          suggested_action: 'Call list_free_models to discover currently-available ids.',
        },
      };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error: {
          code: 'UPSTREAM_HTTP',
          message: `OpenRouter ${res.status} on ${opts.model}: ${text.slice(0, 200)}`,
          retryable: res.status >= 500,
          suggested_action: res.status >= 500 ? 'Retry; OpenRouter or provider had a transient error.' : 'Inspect the request; this is a 4xx and is likely deterministic.',
        },
      };
    }

    let data: ChatCompletionResponse;
    try {
      data = (await res.json()) as ChatCompletionResponse;
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'UPSTREAM_HTTP',
          message: `OpenRouter returned non-JSON response on ${opts.model}.`,
          retryable: true,
          suggested_action: 'Retry; if persistent, file an issue with the model id.',
        },
      };
    }

    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string') {
      return {
        ok: false,
        error: {
          code: 'UPSTREAM_HTTP',
          message: `Empty or malformed completion from ${opts.model}.`,
          retryable: true,
          suggested_action: 'Retry; consider falling back to the next model in the chain.',
        },
      };
    }

    return {
      ok: true,
      content,
      tokens_in: data.usage?.prompt_tokens ?? 0,
      tokens_out: data.usage?.completion_tokens ?? 0,
      finish_reason: choice?.finish_reason ?? 'stop',
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

interface CallOnceSuccess {
  ok: true;
  content: string;
  tokens_in: number;
  tokens_out: number;
  finish_reason: string;
}

interface CallOnceFailure {
  ok: false;
  error: ErrorEnvelope['error'];
}

interface RateLimitedFailure extends CallOnceFailure {
  retry_after_ms?: number;
}

type CallOnceResult = CallOnceSuccess | CallOnceFailure | RateLimitedFailure;

/**
 * Parse Retry-After (HTTP standard, seconds or HTTP-date) AND X-RateLimit-Reset
 * (OpenRouter-specific, epoch ms). Returns the longer of the two as a sleep
 * duration in milliseconds, capped at 0 if neither is parseable.
 */
function parseRetryAfterMs(headers: Headers): number {
  const candidates: number[] = [];

  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const asSeconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(asSeconds) && asSeconds > 0) {
      candidates.push(asSeconds * 1000);
    } else {
      const asDate = Date.parse(retryAfter);
      if (!Number.isNaN(asDate)) {
        const ms = asDate - Date.now();
        if (ms > 0) candidates.push(ms);
      }
    }
  }

  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    const epochMs = Number.parseInt(reset, 10);
    if (Number.isFinite(epochMs)) {
      const ms = epochMs - Date.now();
      if (ms > 0) candidates.push(ms);
    }
  }

  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freeExhaustedError(chain: TaskModelChain): ErrorEnvelope['error'] {
  return {
    code: 'FREE_EXHAUSTED',
    message: `All free models exhausted: ${chain.free_primary}, ${chain.free_fallback}. Paid escalation also failed.`,
    retryable: false,
    suggested_action: 'Inspect logs for the specific upstream error and consider a different task type or model.',
  };
}

/**
 * Estimate cost for a paid call. Best-effort — actual cost comes from the
 * OpenRouter response when available. We use this only for surfacing in the
 * envelope; billing is OpenRouter's source of truth.
 *
 * Conservative: assume per-token pricing, with values pulled from the
 * curated paid-cost-note strings (which are human-readable, not parseable).
 * For now, just return 0 and let docs/MODELS.md inform users about cost.
 * A future pass can wire in pricing from the probe response.
 */
function estimateCost(_model: string, _tokensIn: number, _tokensOut: number): number {
  // TODO: wire probe pricing into per-call cost estimation.
  // For now, we surface cost via the cost_breakdown string in error envelopes.
  return 0;
}
