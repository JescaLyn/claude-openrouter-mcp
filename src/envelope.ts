/**
 * Envelope builders — every tool returns one of these shapes wrapped in the
 * MCP CallToolResult content block. See docs/PLAN.md "Common Response Envelopes".
 */

import type {
  ErrorCode,
  ErrorEnvelope,
  SuccessEnvelope,
} from './types.js';

export function success<T>(opts: {
  result: T;
  model_used: string;
  tokens_in?: number;
  tokens_out?: number;
  finish_reason?: string;
  fallback_chain?: string[];
  cost_usd?: number;
}): SuccessEnvelope<T> {
  return {
    result: opts.result,
    model_used: opts.model_used,
    usage: {
      tokens_in: opts.tokens_in ?? 0,
      tokens_out: opts.tokens_out ?? 0,
    },
    finish_reason: opts.finish_reason ?? 'stop',
    fallback_chain: opts.fallback_chain ?? [opts.model_used],
    cost_usd: opts.cost_usd ?? 0,
  };
}

export function error(opts: {
  code: ErrorCode;
  message: string;
  retryable?: boolean;
  suggested_action: string;
  estimated_cost_usd?: number;
  cost_breakdown?: string;
  suggested_paid_model?: string;
}): ErrorEnvelope {
  return {
    error: {
      code: opts.code,
      message: opts.message,
      retryable: opts.retryable ?? false,
      suggested_action: opts.suggested_action,
      ...(opts.estimated_cost_usd !== undefined && {
        estimated_cost_usd: opts.estimated_cost_usd,
      }),
      ...(opts.cost_breakdown !== undefined && {
        cost_breakdown: opts.cost_breakdown,
      }),
      ...(opts.suggested_paid_model !== undefined && {
        suggested_paid_model: opts.suggested_paid_model,
      }),
    },
  };
}

/**
 * Wrap any envelope in the MCP CallToolResult content shape — `{ content: [{type:'text', text:JSON}], isError? }`.
 * Tools call this once at the end of their handler.
 */
export function toolResult<T>(envelope: SuccessEnvelope<T> | ErrorEnvelope) {
  const isError = 'error' in envelope;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    ...(isError && { isError: true }),
  };
}

/**
 * Convenience: surface an unknown thrown error as an UPSTREAM_HTTP envelope.
 * Used in tool handlers' top-level try/catch so we never leak a raw stack.
 */
export function unknownError(e: unknown, stage: string): ErrorEnvelope {
  const message = e instanceof Error ? e.message : String(e);
  return error({
    code: 'UPSTREAM_HTTP',
    message: `Unexpected error in ${stage}: ${message}`,
    retryable: true,
    suggested_action: 'Retry once; if this persists, file an issue with the stage and message.',
  });
}
