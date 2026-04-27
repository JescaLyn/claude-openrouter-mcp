/**
 * rewrite — rewrite text per an instruction.
 *
 * Combines simplify, tighten, formalize, paraphrase, etc. The `preserve` array
 * pins certain elements (code blocks, quotes, formatting, numbers, links) so the
 * model is told NOT to mangle them — useful when rewriting prose around fixed
 * technical content.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { chainFor } from '../models.js';
import { composeMessages } from '../prompt.js';
import type { ToolContext } from '../types.js';

const PRESERVE_VALUES = ['code', 'quotes', 'formatting', 'numbers', 'links'] as const;
type PreserveValue = (typeof PRESERVE_VALUES)[number];

export const definition = {
  name: 'rewrite',
  description:
    "Rewrite text per an instruction. Combines simplify, tighten, formalize, paraphrase, etc. Use `preserve` to protect code blocks, quotes, formatting, numbers, or links from being mangled. NOT for: large structural rewrites that depend on context outside the snippet.",
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to rewrite.',
      },
      instruction: {
        type: 'string',
        description: "How to rewrite, e.g. 'tighten by 30%', 'convert to passive voice', 'simplify for non-experts'.",
      },
      preserve: {
        type: 'array',
        items: { type: 'string', enum: [...PRESERVE_VALUES] },
        description:
          "Elements to protect from rewriting. `code` = inline code and fenced blocks; `quotes` = quoted text; `formatting` = markdown structure; `numbers` = numeric values and units; `links` = URLs and link text. Default: empty.",
        default: [],
      },
      model: {
        type: 'string',
        description: 'Optional explicit model override; bypasses the curated chain.',
      },
      allow_paid: {
        type: 'boolean',
        description:
          'Allow escalation to a cheap paid model when free fallbacks fail. Default false.',
        default: false,
      },
    },
    required: ['text', 'instruction'],
  },
};

const Args = z.object({
  text: z.string().min(1),
  instruction: z.string().min(1),
  preserve: z.array(z.enum(PRESERVE_VALUES)).default([]),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

const PRESERVE_CLAUSES: Record<PreserveValue, string> = {
  code: 'Preserve inline code spans and fenced code blocks verbatim — do not modify their contents.',
  quotes: 'Preserve direct quotations verbatim — keep the original wording inside quote marks.',
  formatting: 'Preserve markdown structure — headings, lists, emphasis, line breaks — unchanged.',
  numbers: 'Preserve all numeric values and units exactly — do not round, convert, or rephrase numbers.',
  links: 'Preserve URLs and link text exactly — do not rewrite or restructure links.',
};

function buildSystem(args: z.infer<typeof Args>): string {
  const preserveClauses = args.preserve.map((p) => PRESERVE_CLAUSES[p]).join(' ');
  const parts = [
    'You are a careful text rewriter.',
    `Rewrite instruction: ${args.instruction}`,
  ];
  if (preserveClauses) {
    parts.push('PROTECTIONS:', preserveClauses);
  }
  parts.push('Output ONLY the rewritten text. No preamble, no commentary, no source quoting.');
  return parts.join(' ');
}

export async function handler(rawArgs: unknown, ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `rewrite invalid input: ${parsed.error.message}`,
        suggested_action:
          "Verify text and instruction are non-empty and `preserve` items are within the allowed enum.",
      }),
    );
  }
  const args = parsed.data;

  const system = buildSystem(args);
  const messages = composeMessages({
    system,
    instruction: 'Rewrite the following content per the system instructions.',
    untrusted: args.text,
  });

  try {
    const callOpts = { messages, temperature: 0.4 };

    const result = args.model
      ? await ctx.client.chatDirect({ model: args.model, ...callOpts })
      : await ctx.client.chatChain({
          chain: chainFor('rewrite'),
          allow_paid: args.allow_paid,
          ...callOpts,
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
    return toolResult(unknownError(e, 'rewrite'));
  }
}
