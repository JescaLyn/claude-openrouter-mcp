/**
 * generate_regex — derive a regex from a description plus positive/negative
 * examples, with server-side validation.
 *
 * The model is asked to return ONLY the pattern body (no delimiters, no flags).
 * After receiving the pattern, we test it against the examples using JavaScript's
 * RegExp engine. For non-`js` flavors this validation is best-effort: most
 * common metacharacters overlap, but features like PCRE possessive quantifiers,
 * Python named-group syntax variants, or Go's RE2 limitations are NOT modeled.
 *
 * On validation failure: retry ONCE with the failing examples appended to the
 * prompt. If the second attempt still fails, return INVALID_INPUT with the
 * pattern and the failed examples surfaced for the caller.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { composeMessages } from '../prompt.js';
import { chainFor } from '../models.js';
import type { ToolContext } from '../types.js';

export interface RegexValidation {
  positive_passed: boolean[];
  negative_passed: boolean[];
}

export interface RegexResult {
  pattern: string;
  flavor: string;
  validation: RegexValidation;
}

/**
 * Test a pattern against positive and negative examples using the JS engine.
 * Exported for unit tests. Throws if the pattern itself fails to compile;
 * callers should treat a compile error as a hard validation failure.
 */
export function validatePattern(
  pattern: string,
  positive: string[],
  negative: string[],
): RegexValidation {
  const re = new RegExp(pattern);
  return {
    positive_passed: positive.map((s) => re.test(s)),
    negative_passed: negative.map((s) => !re.test(s)),
  };
}

/**
 * Strip common wrappers a model might emit despite "pattern only" instruction.
 * Order matters: trim, then strip code fences, then strip /…/flags delimiters.
 */
function cleanPattern(raw: string): string {
  let s = raw.trim();
  // Strip ```...``` fences (optional language tag).
  const fence = s.match(/^```(?:[a-zA-Z]+)?\n?([\s\S]*?)\n?```$/);
  if (fence && fence[1] !== undefined) s = fence[1].trim();
  // Strip /pattern/flags style if the model wrapped it.
  const slash = s.match(/^\/(.+)\/[gimsuy]*$/);
  if (slash && slash[1] !== undefined) s = slash[1];
  return s;
}

function failedIndices(passed: boolean[]): number[] {
  return passed.map((ok, i) => (ok ? -1 : i)).filter((i) => i >= 0);
}

export const definition = {
  name: 'generate_regex',
  description:
    'Generate a regex from a description plus positive and negative examples, with server-side validation against those examples. On validation failure the tool retries ONCE with the failing examples surfaced; if it still fails, returns INVALID_INPUT with the offending pattern. Validation always uses the JavaScript RegExp engine — for non-js flavors (pcre/python/go) treat validation as best-effort. Use for ad-hoc text-matching needs; the curated free code model handles routine cases well.',
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Natural-language description of what the regex should match.',
      },
      positive_examples: {
        type: 'array',
        items: { type: 'string' },
        description: 'Strings the regex MUST match. At least one is required.',
        minItems: 1,
      },
      negative_examples: {
        type: 'array',
        items: { type: 'string' },
        description: 'Strings the regex must NOT match. Optional but strongly recommended.',
      },
      flavor: {
        type: 'string',
        enum: ['pcre', 'js', 'python', 'go'],
        description:
          "Regex flavor for the model to emit. Default `js`. Server-side validation uses the JS engine regardless — non-js flavors get best-effort checking only.",
        default: 'js',
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
    required: ['description', 'positive_examples'],
  },
};

const Args = z.object({
  description: z.string().min(1),
  positive_examples: z.array(z.string()).min(1),
  negative_examples: z.array(z.string()).optional(),
  flavor: z.enum(['pcre', 'js', 'python', 'go']).default('js'),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

function buildSystem(flavor: string): string {
  return `You are a regex expert. Produce a single ${flavor} regular expression that matches every positive example and rejects every negative example. Output ONLY the pattern body — no delimiters (no surrounding /.../, no flags), no code fences, no commentary, no preamble. Just the pattern characters.`;
}

function buildInstruction(args: {
  description: string;
  positive_examples: string[];
  negative_examples?: string[];
  failedPositive?: string[];
  failedNegative?: string[];
  previousPattern?: string;
}): string {
  const lines: string[] = [];
  lines.push(`Description: ${args.description}`);
  lines.push('');
  lines.push('Positive examples (must match):');
  for (const p of args.positive_examples) lines.push(`- ${JSON.stringify(p)}`);
  if (args.negative_examples && args.negative_examples.length > 0) {
    lines.push('');
    lines.push('Negative examples (must NOT match):');
    for (const n of args.negative_examples) lines.push(`- ${JSON.stringify(n)}`);
  }
  if (args.previousPattern !== undefined) {
    lines.push('');
    lines.push(`Your previous attempt was: ${args.previousPattern}`);
    if (args.failedPositive && args.failedPositive.length > 0) {
      lines.push('It FAILED to match these positives:');
      for (const p of args.failedPositive) lines.push(`- ${JSON.stringify(p)}`);
    }
    if (args.failedNegative && args.failedNegative.length > 0) {
      lines.push('It INCORRECTLY matched these negatives:');
      for (const n of args.failedNegative) lines.push(`- ${JSON.stringify(n)}`);
    }
    lines.push('Fix the pattern and try again.');
  }
  return lines.join('\n');
}

export async function handler(rawArgs: unknown, ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `generate_regex invalid input: ${parsed.error.message}`,
        suggested_action: 'Verify description and positive_examples are present; positive_examples must have at least one string.',
      }),
    );
  }
  const args = parsed.data;
  const negatives = args.negative_examples ?? [];

  const system = buildSystem(args.flavor);

  async function callModel(instruction: string) {
    const messages = composeMessages({ system, instruction });
    if (args.model) {
      return ctx.client.chatDirect({
        model: args.model,
        messages,
        max_tokens: 512,
        temperature: 0.1,
        allow_paid: args.allow_paid,
      });
    }
    return ctx.client.chatChain({
      chain: chainFor('code'),
      messages,
      max_tokens: 512,
      temperature: 0.1,
      allow_paid: args.allow_paid,
    });
  }

  function tryValidate(rawPattern: string): { pattern: string; validation: RegexValidation } | { compileError: string; pattern: string } {
    const pattern = cleanPattern(rawPattern);
    try {
      const validation = validatePattern(pattern, args.positive_examples, negatives);
      return { pattern, validation };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { compileError: message, pattern };
    }
  }

  try {
    // ── Attempt 1 ────────────────────────────────────────────────────────────
    const firstInstruction = buildInstruction({
      description: args.description,
      positive_examples: args.positive_examples,
      negative_examples: negatives,
    });
    const first = await callModel(firstInstruction);
    if (!first.ok) return toolResult(first.envelope);

    let validated = tryValidate(first.content);
    let allPassed =
      'validation' in validated &&
      validated.validation.positive_passed.every(Boolean) &&
      validated.validation.negative_passed.every(Boolean);

    if (allPassed && 'validation' in validated) {
      const result: RegexResult = {
        pattern: validated.pattern,
        flavor: args.flavor,
        validation: validated.validation,
      };
      return toolResult(
        success({
          result,
          model_used: first.model_used,
          tokens_in: first.tokens_in,
          tokens_out: first.tokens_out,
          finish_reason: first.finish_reason,
          fallback_chain: first.fallback_chain,
          cost_usd: first.cost_usd,
        }),
      );
    }

    // ── Attempt 2: retry with failing examples surfaced ──────────────────────
    const previousPattern = 'pattern' in validated ? validated.pattern : '';
    const failedPositive: string[] =
      'validation' in validated
        ? failedIndices(validated.validation.positive_passed).map((i) => args.positive_examples[i]!)
        : args.positive_examples.slice();
    const failedNegative: string[] =
      'validation' in validated
        ? failedIndices(validated.validation.negative_passed).map((i) => negatives[i]!)
        : negatives.slice();

    const retryInstruction = buildInstruction({
      description: args.description,
      positive_examples: args.positive_examples,
      negative_examples: negatives,
      previousPattern,
      failedPositive,
      failedNegative,
    });
    const second = await callModel(retryInstruction);
    if (!second.ok) return toolResult(second.envelope);

    validated = tryValidate(second.content);
    allPassed =
      'validation' in validated &&
      validated.validation.positive_passed.every(Boolean) &&
      validated.validation.negative_passed.every(Boolean);

    if (allPassed && 'validation' in validated) {
      const result: RegexResult = {
        pattern: validated.pattern,
        flavor: args.flavor,
        validation: validated.validation,
      };
      return toolResult(
        success({
          result,
          model_used: second.model_used,
          tokens_in: second.tokens_in,
          tokens_out: second.tokens_out,
          finish_reason: second.finish_reason,
          fallback_chain: second.fallback_chain,
          cost_usd: second.cost_usd,
        }),
      );
    }

    // Still failing — surface as INVALID_INPUT with diagnostics.
    if ('compileError' in validated) {
      return toolResult(
        error({
          code: 'INVALID_INPUT',
          message: `Regex did not compile after retry: ${validated.compileError}. Pattern: ${validated.pattern}`,
          suggested_action: 'Refine description or examples and retry. Consider switching flavor or model.',
        }),
      );
    }

    const finalFailedPositive = failedIndices(validated.validation.positive_passed).map(
      (i) => args.positive_examples[i]!,
    );
    const finalFailedNegative = failedIndices(validated.validation.negative_passed).map(
      (i) => negatives[i]!,
    );

    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `Regex failed validation after retry. Pattern: ${validated.pattern}. Failed positives: ${JSON.stringify(finalFailedPositive)}. Failed negatives: ${JSON.stringify(finalFailedNegative)}.`,
        suggested_action: 'Refine the description or add more disambiguating examples and retry.',
      }),
    );
  } catch (e) {
    return toolResult(unknownError(e, 'generate_regex'));
  }
}
