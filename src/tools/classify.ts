/**
 * classify — assign input(s) to one of a closed label set.
 *
 * Server-side validation rejects any returned label that isn't in the input
 * `labels[]` (anti-hallucination). On a hallucinated label we retry once with
 * a stricter prompt before failing with INVALID_INPUT.
 *
 * Single-item path: `text` populates `items: [text]`. Multi-item path fans out
 * via Promise.all over chatChain calls — one request per item. This trades
 * sequential-batch efficiency for simpler error handling and per-item retries.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { chainFor } from '../models.js';
import { composeMessages } from '../prompt.js';
import type { ChatRequest, ErrorEnvelope, ToolContext } from '../types.js';

export const definition = {
  name: 'classify',
  description:
    "Assign input(s) to one of a closed label set. Use for routing decisions, triage, bucketing. NOT for: rubric-scored review where the rubric is fuzzy (use Claude). Either `text` (single item) OR `items` (batch); not both. Server-side validates that returned labels are in your `labels[]` set; retries once with stricter prompt on hallucinated labels.",
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Single item to classify. Use one of `text` or `items`, not both.',
      },
      items: {
        type: 'array',
        items: { type: 'string' },
        description: 'Multiple items to classify in one call. Use one of `text` or `items`, not both.',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Closed set of allowed labels. The classifier is constrained to pick from this set.',
      },
      multi_label: {
        type: 'boolean',
        description: 'When true, each item may receive multiple labels. When false (default), exactly one label per item.',
        default: false,
      },
      rationale: {
        type: 'boolean',
        description: 'When true, also returns a 1-sentence reason per item.',
        default: false,
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
    required: ['labels'],
  },
};

const Args = z
  .object({
    text: z.string().min(1).optional(),
    items: z.array(z.string().min(1)).min(1).optional(),
    labels: z.array(z.string().min(1)).min(2),
    multi_label: z.boolean().default(false),
    rationale: z.boolean().default(false),
    model: z.string().optional(),
    allow_paid: z.boolean().default(false),
  })
  .refine((a) => (a.text ? !a.items : !!a.items), {
    message: 'Provide exactly one of `text` or `items`.',
  });

type Args = z.infer<typeof Args>;

interface ClassifyOne {
  index: number;
  labels: string[];
  rationale?: string;
}

function buildSystem(args: Args, stricter: boolean): string {
  const labelList = args.labels.map((l) => `"${l}"`).join(', ');
  const rationaleNote = args.rationale
    ? 'Include a one-sentence "rationale" field.'
    : 'Do not include any rationale field.';
  const labelShape = args.multi_label
    ? 'a non-empty array of label strings (one or more)'
    : 'a single-element array containing exactly one label string';
  const stricterClause = stricter
    ? ' STRICT MODE: your previous attempt returned a label outside the allowed set. You MUST pick only from the labels listed above. No paraphrasing, no synonyms, no new labels.'
    : '';
  return [
    'You are a closed-set classifier.',
    `The allowed labels are: [${labelList}].`,
    `Return a single JSON object with shape: { "labels": <${labelShape}>${args.rationale ? ', "rationale": "..."' : ''} }.`,
    'Every label MUST be exactly one of the allowed strings. Do not invent new labels, paraphrase, or change case.',
    rationaleNote,
    'Output ONLY the JSON object; no code fences, no preamble.' + stricterClause,
  ].join(' ');
}

function parseAndValidate(
  content: string,
  allowed: Set<string>,
): { ok: true; labels: string[]; rationale?: string } | { ok: false; reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `non-JSON response: ${msg}` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'response was not a JSON object' };
  }
  const obj = data as Record<string, unknown>;
  const labelsRaw = obj.labels;
  if (!Array.isArray(labelsRaw) || labelsRaw.length === 0) {
    return { ok: false, reason: '`labels` was not a non-empty array' };
  }
  const labels: string[] = [];
  for (const l of labelsRaw) {
    if (typeof l !== 'string') {
      return { ok: false, reason: 'a label was not a string' };
    }
    if (!allowed.has(l)) {
      return { ok: false, reason: `hallucinated label: '${l}'` };
    }
    labels.push(l);
  }
  const rationale = typeof obj.rationale === 'string' ? obj.rationale : undefined;
  return { ok: true, labels, rationale };
}

export async function handler(rawArgs: unknown, ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `classify invalid input: ${parsed.error.message}`,
        suggested_action:
          'Provide exactly one of `text` or `items`, plus `labels` (>= 2 strings).',
      }),
    );
  }
  const args = parsed.data;

  const items = args.items ?? [args.text!];
  const allowed = new Set(args.labels);

  // Aggregate metadata across the fan-out so the envelope reflects the whole batch.
  const aggregateModels = new Set<string>();
  const aggregateChain = new Set<string>();
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCost = 0;
  let lastFinish = 'stop';

  type OneResult =
    | { kind: 'ok'; value: ClassifyOne }
    | { kind: 'upstream'; envelope: ErrorEnvelope }
    | { kind: 'validation'; reason: string };

  const classifyOne = async (item: string, index: number): Promise<OneResult> => {
    let lastReason = 'classification failed';
    for (const stricter of [false, true]) {
      const system = buildSystem(args, stricter);
      const messages = composeMessages({
        system,
        instruction: 'Classify the following item per the system instructions.',
        untrusted: item,
      });

      const callOpts: { messages: ChatRequest['messages']; temperature: number } = {
        messages,
        temperature: 0.0,
      };

      const result = args.model
        ? await ctx.client.chatDirect({ model: args.model, ...callOpts })
        : await ctx.client.chatChain({
            chain: chainFor('classify'),
            allow_paid: args.allow_paid,
            ...callOpts,
          });

      if (!result.ok) {
        return { kind: 'upstream', envelope: result.envelope };
      }

      aggregateModels.add(result.model_used);
      for (const m of result.fallback_chain) aggregateChain.add(m);
      totalTokensIn += result.tokens_in;
      totalTokensOut += result.tokens_out;
      totalCost += result.cost_usd;
      lastFinish = result.finish_reason;

      const parsedOut = parseAndValidate(result.content, allowed);
      if (parsedOut.ok) {
        return {
          kind: 'ok',
          value: {
            index,
            labels: parsedOut.labels,
            ...(parsedOut.rationale && { rationale: parsedOut.rationale }),
          },
        };
      }
      lastReason = parsedOut.reason;
    }
    return { kind: 'validation', reason: `item ${index}: ${lastReason}` };
  };

  try {
    const results = await Promise.all(items.map((item, i) => classifyOne(item, i)));

    const upstreamFail = results.find((r): r is Extract<OneResult, { kind: 'upstream' }> => r.kind === 'upstream');
    if (upstreamFail) {
      return toolResult(upstreamFail.envelope);
    }

    const validationFail = results.find((r): r is Extract<OneResult, { kind: 'validation' }> => r.kind === 'validation');
    if (validationFail) {
      return toolResult(
        error({
          code: 'INVALID_INPUT',
          message: `classify: ${validationFail.reason}. Stricter retry also failed.`,
          suggested_action:
            'Inspect the labels for ambiguity, narrow the input, or relax the closed set.',
        }),
      );
    }

    const ok = (results as Extract<OneResult, { kind: 'ok' }>[]).map((r) => r.value);
    if (!args.multi_label) {
      // Enforce single-label constraint server-side too.
      for (const r of ok) {
        if (r.labels.length !== 1) {
          return toolResult(
            error({
              code: 'INVALID_INPUT',
              message: `classify: item ${r.index} returned ${r.labels.length} labels but multi_label is false.`,
              suggested_action: 'Set multi_label: true, or refine the prompt.',
            }),
          );
        }
      }
    }

    const modelUsed = aggregateModels.size === 1 ? [...aggregateModels][0]! : [...aggregateModels].join(',');

    return toolResult(
      success({
        result: { results: ok },
        model_used: modelUsed,
        tokens_in: totalTokensIn,
        tokens_out: totalTokensOut,
        finish_reason: lastFinish,
        fallback_chain: [...aggregateChain],
        cost_usd: totalCost,
      }),
    );
  } catch (e) {
    return toolResult(unknownError(e, 'classify'));
  }
}
