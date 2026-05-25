/**
 * translate — render text into another natural language.
 *
 * Source language is auto-detected when omitted. Tone shapes the system prompt
 * (`neutral`/`formal`/`casual`). The system prompt instructs the model to output
 * ONLY the translated text — no commentary, no source quoting, no labels.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { chainFor } from '../models.js';
import { composeMessages } from '../prompt.js';
import type { ToolContext } from '../types.js';

export const definition = {
  name: 'translate',
  description:
    "Translate text into another natural language. Use for translating error messages, documentation, user content. Source language auto-detected if omitted. Tone (neutral/formal/casual) shapes register. The model is instructed to output ONLY the translated text, no commentary or labels.",
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to translate.',
      },
      target_lang: {
        type: 'string',
        description: "Target language as a BCP-47 code or English name (e.g. 'es', 'Japanese').",
      },
      source_lang: {
        type: 'string',
        description: 'Optional source language; auto-detected if omitted.',
      },
      tone: {
        type: 'string',
        enum: ['neutral', 'formal', 'casual'],
        description:
          'Register of the translation. `neutral` (default) is the safe choice; `formal` for professional/legal; `casual` for conversational/marketing.',
        default: 'neutral',
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
    required: ['text', 'target_lang'],
  },
};

const Args = z.object({
  text: z.string().min(1),
  target_lang: z.string().min(1),
  source_lang: z.string().min(1).optional(),
  tone: z.enum(['neutral', 'formal', 'casual']).default('neutral'),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

function buildSystem(args: z.infer<typeof Args>): string {
  const sourceClause = args.source_lang
    ? `The source language is ${args.source_lang}.`
    : 'The source language is whatever the input is in; detect it automatically.';

  const toneClause = (() => {
    switch (args.tone) {
      case 'formal':
        return 'Use a formal, professional register suitable for business or legal contexts.';
      case 'casual':
        return 'Use a casual, conversational register suitable for everyday speech.';
      case 'neutral':
      default:
        return 'Use a neutral register — neither overly formal nor overly casual.';
    }
  })();

  return [
    'You are a precise translator.',
    sourceClause,
    `Translate into ${args.target_lang}.`,
    toneClause,
    'Preserve formatting, code spans, URLs, and proper nouns. Translate idioms to natural target-language equivalents.',
    'Output ONLY the translated text. Do not include the source, language labels, quotes around the result, or any commentary.',
  ].join(' ');
}

export async function handler(rawArgs: unknown, ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `translate invalid input: ${parsed.error.message}`,
        suggested_action: 'Verify text and target_lang are non-empty.',
      }),
    );
  }
  const args = parsed.data;

  const system = buildSystem(args);
  const messages = composeMessages({
    system,
    instruction: 'Translate the following content per the system instructions.',
    untrusted: args.text,
  });

  try {
    const callOpts = { messages, temperature: 0.2 };

    const result = args.model
      ? await ctx.client.chatDirect({ model: args.model, allow_paid: args.allow_paid, ...callOpts })
      : await ctx.client.chatChain({
          chain: chainFor('translate'),
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
    return toolResult(unknownError(e, 'translate'));
  }
}
