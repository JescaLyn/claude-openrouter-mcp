/**
 * explain_code — plain-language explanation of a code snippet.
 *
 * Routes through the `code` task chain. The `focus` enum steers the system
 * prompt: behavior (default) walks through what the code does; complexity
 * highlights time/space tradeoffs; errors enumerates failure modes; security
 * surfaces vulnerability patterns.
 *
 * Use for understanding unfamiliar code, third-party library internals, or
 * teaching material. Not for explanations that need repo-wide context.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { composeMessages } from '../prompt.js';
import { chainFor } from '../models.js';
import type { ToolContext } from '../types.js';

const FOCUS_GUIDANCE: Record<'behavior' | 'complexity' | 'errors' | 'security', string> = {
  behavior:
    'Walk through what the code does step by step. Identify inputs, outputs, side effects, and the core control flow. Aim for clarity over completeness.',
  complexity:
    'Analyze time and space complexity. Call out hot loops, allocation patterns, and any obvious tradeoffs. Use Big-O notation where appropriate.',
  errors:
    'Enumerate failure modes: thrown exceptions, error returns, edge cases (null/empty/overflow), and unhandled paths. Note where the code assumes invariants that might not hold.',
  security:
    'Surface security-relevant patterns: input handling, injection surfaces, auth/authz assumptions, secret handling, and unsafe operations. Flag patterns that warrant deeper review even if they are not definitively bugs.',
};

export const definition = {
  name: 'explain_code',
  description:
    'Plain-language explanation of a code snippet via a curated free code-tuned model. Use for understanding unfamiliar code, third-party library internals, or generating teaching material. Steer the explanation with `focus` (behavior/complexity/errors/security). NOT for: explanations that require repo-wide context, cross-file call graphs, or build-system reasoning — use Claude directly for those.',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'The source code to explain.',
      },
      language: {
        type: 'string',
        description: "Optional language hint, e.g. 'typescript' or 'python'. Improves accuracy when the snippet is short or ambiguous.",
      },
      focus: {
        type: 'string',
        enum: ['behavior', 'complexity', 'errors', 'security'],
        description:
          "Aspect to emphasize. `behavior` (default) = step-by-step walk; `complexity` = time/space; `errors` = failure modes; `security` = vulnerability patterns.",
        default: 'behavior',
      },
      model: {
        type: 'string',
        description: 'Optional explicit model override. Bypasses the curated chain.',
      },
      allow_paid: {
        type: 'boolean',
        description:
          'Allow escalation to a cheap paid model when free fallbacks fail. Default false; tool returns PAID_CONFIRMATION_REQUIRED first.',
        default: false,
      },
    },
    required: ['code'],
  },
};

const Args = z.object({
  code: z.string().min(1),
  language: z.string().optional(),
  focus: z.enum(['behavior', 'complexity', 'errors', 'security']).default('behavior'),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

export async function handler(rawArgs: unknown, ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `explain_code invalid input: ${parsed.error.message}`,
        suggested_action: 'Verify code is non-empty and focus is one of behavior/complexity/errors/security.',
      }),
    );
  }
  const args = parsed.data;

  const langHint = args.language ? ` The language is ${args.language}.` : '';
  const system = `You are a senior engineer explaining code to a competent peer. ${FOCUS_GUIDANCE[args.focus]}${langHint} Output prose only — no preamble like "Sure, here is..." and no echoing the code back.`;

  const instruction = `Explain the following code with focus on ${args.focus}.`;

  const messages = composeMessages({
    system,
    instruction,
    untrusted: args.code,
  });

  try {
    if (args.model) {
      const result = await ctx.client.chatDirect({
        model: args.model,
        messages,
        max_tokens: 2048,
        temperature: 0.3,
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

    const chain = chainFor('code');
    const result = await ctx.client.chatChain({
      chain,
      messages,
      max_tokens: 2048,
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
    return toolResult(unknownError(e, 'explain_code'));
  }
}
