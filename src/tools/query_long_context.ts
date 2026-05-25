/**
 * query_long_context — route a very-large-input prompt to a free 262K-context model.
 *
 * Use when the combined input + question is >100K tokens (whole-repo dumps,
 * log haystack search, multi-document Q&A). For typical-size queries, prefer
 * `query_free` with task_type='general' — long-context models are not free
 * lunch on smaller inputs (they run with the same daily caps and are slower).
 *
 * Routes through the `long_context` task chain. Default primary is
 * qwen/qwen3-next-80b-a3b-instruct (262K ctx); override with `model` to pin
 * a specific id.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { composeMessages } from '../prompt.js';
import { chainFor } from '../models.js';
import type { ToolContext } from '../types.js';

export const definition = {
  name: 'query_long_context',
  description:
    'Route a query with very large input (>100K tokens) to a free 262K-context model. Use for whole-repo dumps, log haystack search, and multi-document Q&A where the input is too big for normal text models. NOT for: typical-size queries — use query_free or a named tool. Default model is qwen/qwen3-next-80b-a3b-instruct:free; override with `model` if needed.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'The full prompt — combined input (the haystack/repo dump/logs) and the question. Compose them into a single string before calling.',
      },
      model: {
        type: 'string',
        description:
          'Optional explicit model override. Defaults to the curated long-context primary (qwen/qwen3-next-80b-a3b-instruct).',
      },
      max_tokens: {
        type: 'integer',
        description: 'Max output tokens. Defaults to 4096.',
        default: 4096,
      },
      allow_paid: {
        type: 'boolean',
        description:
          'Allow escalation to a cheap paid model when free fallbacks fail. Default false; tool returns PAID_CONFIRMATION_REQUIRED first with a cost estimate.',
        default: false,
      },
    },
    required: ['prompt'],
  },
};

const Args = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  max_tokens: z.number().int().positive().max(32_768).default(4096),
  allow_paid: z.boolean().default(false),
});

export async function handler(rawArgs: unknown, ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `query_long_context invalid input: ${parsed.error.message}`,
        suggested_action: 'Verify prompt is non-empty and max_tokens is a positive integer.',
      }),
    );
  }
  const args = parsed.data;

  const messages = composeMessages({
    instruction: args.prompt,
  });

  try {
    if (args.model) {
      const result = await ctx.client.chatDirect({
        model: args.model,
        messages,
        max_tokens: args.max_tokens,
        temperature: 0.3,
        allow_paid: args.allow_paid,
      });
      if (!result.ok) return toolResult(result.envelope);
      return toolResult(
        success({
          result: result.content,
          model_used: result.model_used,
          tokens_in: result.tokens_in,
          tokens_out: result.tokens_out,
          finish_reason: result.finish_reason,
          fallback_chain: result.fallback_chain,
          cost_usd: result.cost_usd,
        }),
      );
    }

    const chain = chainFor('long_context');
    const result = await ctx.client.chatChain({
      chain,
      messages,
      max_tokens: args.max_tokens,
      temperature: 0.3,
      allow_paid: args.allow_paid,
    });

    if (!result.ok) return toolResult(result.envelope);
    return toolResult(
      success({
        result: result.content,
        model_used: result.model_used,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        finish_reason: result.finish_reason,
        fallback_chain: result.fallback_chain,
        cost_usd: result.cost_usd,
      }),
    );
  } catch (e) {
    return toolResult(unknownError(e, 'query_long_context'));
  }
}
