/**
 * summarize — compress text to a brief summary.
 *
 * Routes via task_type to a free model tuned for summarization. Picks
 * `summarize_short` for typical input; switches to `summarize_long` (a
 * long-context model) once the input crosses ~30K characters.
 *
 * Style options shape the system prompt; max_chars is a soft length cap
 * communicated to the model (NOT a hard token-budget — that's max_tokens
 * on the underlying request).
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { chainFor } from '../models.js';
import { composeMessages } from '../prompt.js';
import type { ToolContext } from '../types.js';

const LONG_INPUT_THRESHOLD = 30_000;

export const definition = {
  name: 'summarize',
  description:
    'Compress text to a brief summary. Use for routine summarization of search results, log dumps, file contents, web fetches. NOT for: long-document selective summarization with strict exclusion criteria (use Claude directly). Style controls shape (concise/detailed/bullets/tldr); max_chars caps length; focus emphasizes a particular aspect.',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to summarize.',
      },
      style: {
        type: 'string',
        enum: ['concise', 'detailed', 'bullets', 'tldr'],
        description:
          "Summary shape. `concise` = 2-3 short sentences; `detailed` = paragraph with key supporting points; `bullets` = bulleted list of main points; `tldr` = one-sentence punchline. Defaults to `concise`.",
        default: 'concise',
      },
      max_chars: {
        type: 'integer',
        description:
          'Approximate character cap for the summary. The model is asked to stay within this length; treat it as a soft target, not a hard cutoff. Defaults to 400.',
        default: 400,
      },
      focus: {
        type: 'string',
        description:
          "Optional aspect to emphasize, e.g. 'security implications' or 'performance impact'. Folded into the system prompt.",
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
    required: ['text'],
  },
};

const Args = z.object({
  text: z.string().min(1),
  style: z.enum(['concise', 'detailed', 'bullets', 'tldr']).default('concise'),
  max_chars: z.number().int().positive().max(10_000).default(400),
  focus: z.string().optional(),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

function buildSystemPrompt(style: string, max_chars: number, focus: string | undefined): string {
  const styleInstruction = (() => {
    switch (style) {
      case 'detailed':
        return 'Write a detailed paragraph summary that captures the main points and key supporting details.';
      case 'bullets':
        return 'Write a bulleted list of the main points. Each bullet should be a short, complete thought.';
      case 'tldr':
        return 'Write a single-sentence "TL;DR" punchline that captures the gist.';
      case 'concise':
      default:
        return 'Write a concise summary in 2-3 short sentences capturing the essential meaning.';
    }
  })();

  const focusClause = focus
    ? ` Emphasize the following aspect: ${focus}.`
    : '';

  return [
    'You are a careful summarizer.',
    styleInstruction,
    `Stay within approximately ${max_chars} characters.${focusClause}`,
    'Output only the summary itself. Do not include preamble, meta-commentary, or quoted source text.',
  ].join(' ');
}

export async function handler(rawArgs: unknown, ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `summarize invalid input: ${parsed.error.message}`,
        suggested_action: 'Verify text is non-empty and style/max_chars are within range.',
      }),
    );
  }
  const args = parsed.data;

  const system = buildSystemPrompt(args.style, args.max_chars, args.focus);
  const messages = composeMessages({
    system,
    instruction: 'Summarize the following content according to the system instructions.',
    untrusted: args.text,
  });

  const taskType = args.text.length < LONG_INPUT_THRESHOLD ? 'summarize_short' : 'summarize_long';

  try {
    if (args.model) {
      const result = await ctx.client.chatDirect({
        model: args.model,
        messages,
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

    const chain = chainFor(taskType);
    const result = await ctx.client.chatChain({
      chain,
      messages,
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
    return toolResult(unknownError(e, 'summarize'));
  }
}
