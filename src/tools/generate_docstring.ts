/**
 * generate_docstring — produce a docstring/JSDoc/TSDoc for a function.
 *
 * Routes through the `code` task chain. Style is selected by language when not
 * explicitly provided: python→google, javascript→jsdoc, typescript→tsdoc,
 * go→go-style, rust→rust. Output is the docstring TEXT only, not the function
 * body with the docstring inserted.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { composeMessages } from '../prompt.js';
import { chainFor } from '../models.js';
import type { ToolContext } from '../types.js';

type DocStyle = 'google' | 'numpy' | 'jsdoc' | 'tsdoc' | 'rust' | 'go-style';

const STYLE_GUIDANCE: Record<DocStyle, string> = {
  google:
    'Google-style Python docstring: triple-quoted, sections for Args, Returns, Raises. One-line summary, blank line, longer description if needed.',
  numpy:
    'NumPy-style Python docstring: triple-quoted, sections with dashed underlines (Parameters, Returns, Raises). One-line summary, blank line, longer description if needed.',
  jsdoc:
    'JSDoc block comment: /** ... */ with @param, @returns, @throws tags. Use plain types (no TS syntax). One-line summary first.',
  tsdoc:
    'TSDoc block comment: /** ... */ with @param, @returns, @throws. Do not duplicate TypeScript types in tags; describe semantics, not the type.',
  rust:
    'Rust doc comment: /// for items, //! for module-level. Markdown-formatted. Include # Examples if a simple example fits, # Errors for fallible APIs, # Panics where relevant.',
  'go-style':
    'Go doc comment: // line comments directly above the declaration. Start with the identifier name as the first word. Plain prose, no tags.',
};

function defaultStyleFor(language: string): DocStyle {
  const normalized = language.toLowerCase().trim();
  if (normalized === 'python' || normalized === 'py') return 'google';
  if (normalized === 'javascript' || normalized === 'js') return 'jsdoc';
  if (normalized === 'typescript' || normalized === 'ts') return 'tsdoc';
  if (normalized === 'go' || normalized === 'golang') return 'go-style';
  if (normalized === 'rust' || normalized === 'rs') return 'rust';
  // Reasonable default for unknown languages.
  return 'jsdoc';
}

export const definition = {
  name: 'generate_docstring',
  description:
    'Generate a docstring/JSDoc/TSDoc for a single function via a curated free code-tuned model. Returns the docstring TEXT only — does not splice it into the function body. Style defaults by language (python→google, javascript→jsdoc, typescript→tsdoc, go→go-style, rust→rust). Use for self-contained functions; the model has no repo context. NOT for: functions whose behavior depends on framework lifecycle, caller assumptions, or cross-file contracts.',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'The source of the function (or a tight set of related declarations) to document.',
      },
      language: {
        type: 'string',
        description: "Language of the code, e.g. 'python', 'typescript', 'go', 'rust'.",
      },
      style: {
        type: 'string',
        enum: ['google', 'numpy', 'jsdoc', 'tsdoc', 'rust'],
        description:
          "Docstring convention to emit. Defaults pick by language: python→google, javascript→jsdoc, typescript→tsdoc, go→go-style, rust→rust.",
      },
      model: {
        type: 'string',
        description: 'Optional explicit model override. Bypasses the curated chain.',
      },
      allow_paid: {
        type: 'boolean',
        description: 'Allow escalation to a cheap paid model when free fallbacks fail. Default false.',
        default: false,
      },
    },
    required: ['code', 'language'],
  },
};

const Args = z.object({
  code: z.string().min(1),
  language: z.string().min(1),
  style: z.enum(['google', 'numpy', 'jsdoc', 'tsdoc', 'rust']).optional(),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

export async function handler(rawArgs: unknown, ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `generate_docstring invalid input: ${parsed.error.message}`,
        suggested_action: 'Verify code and language are non-empty and style (if provided) is in the enum.',
      }),
    );
  }
  const args = parsed.data;

  const style: DocStyle = args.style ?? defaultStyleFor(args.language);

  const system = `You are a senior engineer writing docstrings. ${STYLE_GUIDANCE[style]} Output ONLY the docstring text — do NOT echo the function signature or body, do NOT wrap in code fences, do NOT add any preamble. The output will be pasted directly above the function.`;

  const instruction = `Write a ${style} docstring for the following ${args.language} code.`;

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
        max_tokens: 1024,
        temperature: 0.2,
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
      max_tokens: 1024,
      temperature: 0.2,
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
    return toolResult(unknownError(e, 'generate_docstring'));
  }
}
