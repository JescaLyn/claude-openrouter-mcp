/**
 * commit_message — generate a single-line commit message from a git diff.
 *
 * Accepts any diff format: staged (`git diff --cached`), unstaged (`git diff`),
 * branch-to-branch (`git diff main..HEAD`), worktree diff, or a patch file.
 * Pass `diff_context` to frame the instruction when the diff is not a simple
 * staged unit (e.g. "last 3 commits" or "branch vs main").
 *
 * Routes through the `commit_message` task chain. Default style: past-tense
 * verbs, sentence case, ending with a period, parallel structure for
 * multi-change, plain ASCII only. Pass `instructions` to append custom style rules.
 *
 * If `scope_hint` is provided, it is prepended to the user message as guidance
 * (NOT as a conventional-commit prefix).
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { composeMessages } from '../prompt.js';
import { chainFor } from '../models.js';
import type { ToolContext } from '../types.js';

const SYSTEM_PROMPT = [
  'Write a single-line git commit message in this exact style:',
  '- Past-tense verbs (Fixed, Added, Removed, Updated, Refactored, etc.)',
  '- Sentence case',
  '- Ends with a period',
  "- Parallel structure for multi-change ('Fixed X, added Y, and removed Z.')",
  "- Plain ASCII only — no symbols like + → ✓, use words ('and', not '+')",
  '- Describe WHAT changed and WHY, not where (no file paths)',
  "- One sentence; if there's a why-elaboration, it goes in the body, blank line separator",
  'Return ONLY the message, no preamble or formatting.',
].join('\n');

export const definition = {
  name: 'commit_message',
  description:
    "Generate a commit message from a git diff via a curated free model. Accepts any diff format — staged (git diff --cached), branch-to-branch (git diff main..HEAD), worktree, or patch. Default style: past-tense verbs, sentence case, ends with a period, parallel structure for multi-change ('Fixed X, added Y, and removed Z.'), plain ASCII, 'and' instead of symbols, describes what and why (not where). Pass `diff_context` to describe the diff scope; pass `instructions` to append custom style rules. NOT for: writing PR descriptions or release notes — use Claude directly there.",
  inputSchema: {
    type: 'object',
    properties: {
      diff: {
        type: 'string',
        description:
          'Any git diff output — staged (`git diff --cached`), unstaged (`git diff`), branch-to-branch (`git diff main..HEAD`), worktree diff, or a patch file.',
      },
      diff_context: {
        type: 'string',
        description:
          "Describes what the diff represents. Examples: 'staged changes', 'branch vs main', 'worktree changes', 'last 3 commits'. Frames the commit message appropriately for multi-commit ranges vs. a single staged unit.",
      },
      instructions: {
        type: 'string',
        description: 'Custom style instructions appended to the default system prompt.',
      },
      scope_hint: {
        type: 'string',
        description: "Repo or area hint, e.g. 'auth module' or 'frontend'. Used as guidance, NOT as a conventional-commit prefix.",
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
    required: ['diff'],
  },
};

const Args = z.object({
  diff: z.string().min(1),
  diff_context: z.string().min(1).optional(),
  instructions: z.string().min(1).optional(),
  scope_hint: z.string().optional(),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

export async function handler(rawArgs: unknown, ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `commit_message invalid input: ${parsed.error.message}`,
        suggested_action: 'Verify diff is non-empty.',
      }),
    );
  }
  const args = parsed.data;

  const instructionParts: string[] = [];
  if (args.scope_hint) {
    instructionParts.push(`Scope hint: ${args.scope_hint}`);
  }
  const diffFrame = args.diff_context
    ? `Write a commit message for the following diff (${args.diff_context}).`
    : 'Write a commit message for the following staged diff.';
  instructionParts.push(diffFrame);
  const instruction = instructionParts.join('\n');

  const messages = composeMessages({
    system: args.instructions
      ? `${SYSTEM_PROMPT}\n\nAdditional style instructions:\n${args.instructions}`
      : SYSTEM_PROMPT,
    instruction,
    untrusted: args.diff,
  });

  try {
    if (args.model) {
      const result = await ctx.client.chatDirect({
        model: args.model,
        messages,
        max_tokens: 256,
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

    const chain = chainFor('commit_message');
    const result = await ctx.client.chatChain({
      chain,
      messages,
      max_tokens: 256,
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
    return toolResult(unknownError(e, 'commit_message'));
  }
}
