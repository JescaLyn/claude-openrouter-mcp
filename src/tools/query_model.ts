/**
 * query_model — raw passthrough to OpenRouter for a specific model.
 *
 * No chain fallback. The caller picks the model. Useful when:
 *   - You need full control (specific provider, exotic config via `extra`)
 *   - You want a model not covered by the curated chain
 *   - You're testing a specific model's behavior
 *
 * For routine tasks, prefer named tools (summarize, extract, classify, etc.).
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { composeMessages } from '../prompt.js';
import type { ToolContext } from '../types.js';

export const definition = {
  name: 'query_model',
  description:
    'Generic OpenRouter chat completion against an explicitly-named model. Use when no purpose-specific tool fits, or when you need to call a specific model. For routine tasks (summarize, extract, classify), prefer the named tool — it has a curated fallback chain. The `extra` field splats additional parameters into the OpenRouter request body for features we don\'t model in the typed interface.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The user prompt sent to the model.',
      },
      model: {
        type: 'string',
        description:
          "Full OpenRouter model id, e.g. 'meta-llama/llama-3.3-70b-instruct:free'. Use list_free_models to discover available ids.",
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
      allow_paid: {
        type: 'boolean',
        description:
          'Acknowledge that the chosen model may be paid. This is advisory — the call runs regardless, since the caller is explicitly naming the model. Use it as a self-documenting signal that you have confirmed the model\'s pricing. For gated cost confirmation, use a named tool (summarize, classify, etc.) which enforces allow_paid on its chain. Defaults to false.',
        default: false,
      },
      extra: {
        type: 'object',
        description:
          'Passthrough to OpenRouter request body. Use for provider preferences, response_format, structured-output schemas, and other OpenRouter-specific fields not modeled here. NOT validated server-side; whatever you pass is splatted into the request.',
        additionalProperties: true,
      },
    },
    required: ['prompt', 'model'],
  },
};

const Args = z.object({
  prompt: z.string().min(1),
  model: z.string().min(1),
  system: z.string().optional(),
  max_tokens: z.number().int().positive().max(32_768).default(2048),
  temperature: z.number().min(0).max(2).default(0.3),
  allow_paid: z.boolean().default(false),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export async function handler(rawArgs: unknown, ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `query_model invalid input: ${parsed.error.message}`,
        suggested_action: 'Verify required fields (prompt, model) and parameter ranges.',
      }),
    );
  }
  const args = parsed.data;

  const messages = composeMessages({
    system: args.system,
    instruction: args.prompt,
  });

  try {
    const result = await ctx.client.chatDirect({
      model: args.model,
      messages,
      max_tokens: args.max_tokens,
      temperature: args.temperature,
      ...(args.extra && { extra: args.extra }),
    });

    if (!result.ok) {
      return toolResult(result.envelope);
    }

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
    return toolResult(unknownError(e, 'query_model'));
  }
}
