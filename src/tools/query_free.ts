/**
 * query_free — generic query against a curated free model.
 *
 * Use as the escape hatch when no purpose-specific tool fits. Routes via the
 * task_type hint to a sensibly tuned free model with a fallback chain.
 *
 * For routine tasks, prefer the specific named tool — it has the right
 * prompt template + parameter shape. query_free is for ad-hoc work.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { chainFor } from '../models.js';
import { composeMessages } from '../prompt.js';
import type { ToolContext } from '../types.js';

export const definition = {
  name: 'query_free',
  description:
    'Generic query against a curated free OpenRouter model. Use as the escape hatch when no purpose-specific tool fits. Routes via task_type hint (general/reasoning/code/creative/long_context) to a sensibly tuned free model. For routine tasks (summarize, extract, classify), prefer the specific named tool — it has the right prompt template baked in.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The user prompt sent to the model.',
      },
      task_type: {
        type: 'string',
        enum: ['general', 'reasoning', 'code', 'creative', 'long_context'],
        description:
          'Hint for model selection. `general` = balanced default; `reasoning` = harder thinking; `code` = code-tuned; `creative` = generation/rewriting; `long_context` = >100K input. Defaults to `general`.',
        default: 'general',
      },
      system: {
        type: 'string',
        description: 'Optional system prompt prepended to the conversation.',
      },
      max_tokens: {
        type: 'integer',
        description: 'Max output tokens.',
        default: 2048,
      },
      temperature: {
        type: 'number',
        description: 'Sampling temperature, 0–2.',
        default: 0.3,
      },
      model: {
        type: 'string',
        description:
          'Optional explicit model override. Bypasses the curated chain. Use list_free_models to discover ids.',
      },
      allow_paid: {
        type: 'boolean',
        description:
          'Allow escalation to a cheap paid model when free fallbacks fail. Default false; the tool returns PAID_CONFIRMATION_REQUIRED with a cost estimate when free runs out, and the caller must explicitly retry with allow_paid: true.',
        default: false,
      },
    },
    required: ['prompt'],
  },
};

const Args = z.object({
  prompt: z.string().min(1),
  task_type: z
    .enum(['general', 'reasoning', 'code', 'creative', 'long_context'])
    .default('general'),
  system: z.string().optional(),
  max_tokens: z.number().int().positive().max(32_768).default(2048),
  temperature: z.number().min(0).max(2).default(0.3),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

export async function handler(rawArgs: unknown, ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `query_free invalid input: ${parsed.error.message}`,
        suggested_action: 'Verify the prompt is non-empty and task_type is in the enum.',
      }),
    );
  }
  const args = parsed.data;

  const messages = composeMessages({
    system: args.system,
    instruction: args.prompt,
  });

  try {
    // If the caller passed an explicit model, route through chatDirect.
    if (args.model) {
      const result = await ctx.client.chatDirect({
        model: args.model,
        messages,
        max_tokens: args.max_tokens,
        temperature: args.temperature,
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

    const chain = chainFor(args.task_type);
    const result = await ctx.client.chatChain({
      chain,
      messages,
      max_tokens: args.max_tokens,
      temperature: args.temperature,
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
    return toolResult(unknownError(e, 'query_free'));
  }
}
