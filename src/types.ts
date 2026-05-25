/**
 * Shared types — envelopes, errors, tool context, model entries.
 *
 * The envelope shape is the contract every tool returns; see docs/PLAN.md
 * "Common Response Envelopes" and docs/TOOLS.md for the full spec.
 */

export type ErrorCode =
  | 'UPSTREAM_HTTP'
  | 'UPSTREAM_TIMEOUT'
  | 'MODEL_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'FREE_EXHAUSTED'
  | 'PAID_CONFIRMATION_REQUIRED'
  | 'RESOURCE_TOO_LARGE'
  | 'INVALID_INPUT'
  | 'MISSING_CREDENTIAL';

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    suggested_action: string;
    /** Present on PAID_CONFIRMATION_REQUIRED and FREE_EXHAUSTED. */
    estimated_cost_usd?: number;
    /** Human-readable cost breakdown, e.g. "FLUX.2 Pro · 1MP × $0.030". */
    cost_breakdown?: string;
    /** Optional model id we'd escalate to on a paid retry. */
    suggested_paid_model?: string;
  };
}

export interface SuccessEnvelope<T = unknown> {
  result: T;
  model_used: string;
  usage: {
    tokens_in: number;
    tokens_out: number;
  };
  finish_reason: string;
  fallback_chain: string[];
  cost_usd: number;
}

export type Envelope<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope;

export function isErrorEnvelope(e: Envelope): e is ErrorEnvelope {
  return 'error' in e;
}

/**
 * One entry in src/models.ts — what we know about a curated model for a task.
 * Free vs paid is derived from pricing fields, not stored separately.
 */
export interface ModelEntry {
  /** Full OpenRouter model id, e.g. "openai/gpt-oss-120b:free". */
  id: string;
  /** True if this entry is intended for a paid escalation (last resort). */
  paid: boolean;
  /** Optional cost annotation for paid models — "~$0.0004 per 2K-in/500-out call". */
  cost_note?: string;
}

/**
 * Per-task model chain: free primary → free fallback → paid escalation.
 */
export interface TaskModelChain {
  free_primary: string;
  free_fallback: string;
  paid_escalation: string;
  /** Cost note for the paid escalation tier, surfaced in PAID_CONFIRMATION_REQUIRED. */
  paid_cost_note: string;
}

/**
 * The OpenRouterClient is passed into each tool handler as part of ToolContext.
 * Tools never import the client at module scope — that pattern was the dominant
 * testing-pain finding from the prior-art audit.
 */
export interface ToolContext {
  client: import('./client.js').OpenRouterClient;
  /** AbortSignal from the MCP transport — fires when the client disconnects or cancels. */
  signal?: AbortSignal;
}

/**
 * Task type hints used by query_free and the per-task chain lookup.
 * Keep the enum tight; new task types should be added deliberately.
 */
export type TaskType =
  | 'general'
  | 'reasoning'
  | 'code'
  | 'creative'
  | 'long_context'
  | 'summarize_short'
  | 'summarize_long'
  | 'extract'
  | 'classify'
  | 'translate'
  | 'rewrite'
  | 'commit_message'
  | 'extract_text'
  | 'analyze_image'
  | 'read_pdf'
  | 'analyze_video';

/**
 * OpenRouter chat-completions request — minimal shape we care about.
 * The `extra` field on query_model splats arbitrary keys into the request body,
 * so the typed shape doesn't need to track every OpenRouter feature.
 */
export interface ChatRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | Array<unknown>;
  }>;
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: 'json_schema'; json_schema: unknown };
  provider?: ProviderPreferences;
  /** Anything else — splatted into the request body. */
  [key: string]: unknown;
}

export interface ProviderPreferences {
  sort?: 'price' | 'latency' | 'throughput';
  data_collection?: 'allow' | 'deny';
  require_parameters?: boolean;
  allow_fallbacks?: boolean;
  order?: string[];
  only?: string[];
  ignore?: string[];
}

/**
 * Slim view of an OpenRouter model entry — enough for probing and lookup,
 * without dragging the full frontend response shape through the codebase.
 */
export interface ModelInfo {
  id: string;
  name?: string;
  context_length: number;
  is_free: boolean;
  input_modalities: string[];
  output_modalities: string[];
  pricing: {
    prompt: number;
    completion: number;
    image_output: number;
    audio: number;
    video_output: number;
    request: number;
  };
  /** Source of this info: live frontend probe, v1 fallback, or bundled snapshot. */
  source: 'frontend' | 'v1' | 'snapshot';
}
