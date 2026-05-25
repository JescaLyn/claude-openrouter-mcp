/**
 * extract — pull fields from text into a JSON-schema-shaped object.
 *
 * Uses OpenRouter's structured-output (`response_format: json_schema, strict: true`)
 * to constrain the model. After the response, we JSON.parse the content; on parse
 * failure we surface INVALID_INPUT. When `allow_missing: false`, we additionally
 * verify every required field in the schema is present and non-null in the result;
 * any missing required field returns INVALID_INPUT with the failing path.
 *
 * The curated `extract` chain points at gpt-oss-120b — verified for strict
 * json_schema support. Models without it would silently drop the response_format.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { chainFor } from '../models.js';
import { composeMessages } from '../prompt.js';
import { MAX_SCHEMA_BYTES } from '../security.js';
import type { ToolContext } from '../types.js';

export const definition = {
  name: 'extract',
  description:
    "Pull fields from text into a JSON schema. Use for entity extraction, structured note-taking, parsing semi-structured input. NOT for: multi-hop extraction that requires linking entities across sections (use Claude). Each schema field's `description` is shown to the model — be specific. Returns a JSON object matching the schema; on parse or validation failure, returns INVALID_INPUT with the failing field path.",
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The source text to extract fields from.',
      },
      schema: {
        type: 'object',
        description:
          "JSON Schema describing the fields to extract. Each field's `description` is shown to the model and should be specific (e.g. 'ISO-8601 date in UTC').",
        additionalProperties: true,
      },
      instructions: {
        type: 'string',
        description: 'Optional extra guidance prepended to the system prompt.',
      },
      allow_missing: {
        type: 'boolean',
        description:
          'When true (default), missing required fields return null in the result. When false, any missing required field returns INVALID_INPUT with the failing path.',
        default: true,
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
    required: ['text', 'schema'],
  },
};

const Args = z.object({
  text: z.string().min(1),
  schema: z
    .record(z.string(), z.unknown())
    // Cap schema size to prevent DOS via deeply-nested or $ref-cycled schemas.
    .refine((s) => JSON.stringify(s).length <= MAX_SCHEMA_BYTES, {
      message: `schema exceeds ${MAX_SCHEMA_BYTES}-byte cap (deeply nested or $ref-cycled?)`,
    }),
  instructions: z.string().optional(),
  allow_missing: z.boolean().default(true),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

/**
 * Walk the JSON Schema and verify every `required` field at every object level
 * is present and non-null. Returns the dotted path of the first failure, or null.
 */
function findMissingRequired(
  schema: Record<string, unknown>,
  data: unknown,
  path: string[] = [],
): string | null {
  if (data === null || data === undefined) {
    return path.length > 0 ? path.join('.') : '<root>';
  }
  if (typeof schema !== 'object' || schema === null) return null;

  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const properties =
    typeof schema.properties === 'object' && schema.properties !== null
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};

  if (typeof data !== 'object' || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;

  for (const key of required) {
    if (!(key in obj) || obj[key] === null || obj[key] === undefined) {
      return [...path, key].join('.');
    }
  }

  for (const [key, sub] of Object.entries(properties)) {
    if (key in obj && obj[key] !== null && obj[key] !== undefined) {
      const nested = findMissingRequired(sub, obj[key], [...path, key]);
      if (nested) return nested;
    }
  }

  return null;
}

export async function handler(rawArgs: unknown, ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `extract invalid input: ${parsed.error.message}`,
        suggested_action: 'Verify text is non-empty and schema is a JSON-Schema object.',
      }),
    );
  }
  const args = parsed.data;

  const systemParts = [
    'You are a precise field-extractor.',
    'Read the untrusted content and emit a single JSON object that conforms to the provided schema.',
    'Output ONLY valid JSON; no preamble, no code fences, no commentary.',
    args.allow_missing
      ? 'If a field is not present in the source, return null for it.'
      : 'Every required field MUST be present. Do not fabricate values; if truly absent, return null and the caller will surface an error.',
  ];
  if (args.instructions) systemParts.push(args.instructions);
  const system = systemParts.join(' ');

  const messages = composeMessages({
    system,
    instruction:
      'Extract the schema-shaped fields from the following content and return a single JSON object.',
    untrusted: args.text,
  });

  const responseFormat = {
    type: 'json_schema' as const,
    json_schema: {
      name: 'extraction',
      strict: true,
      schema: args.schema,
    },
  };

  try {
    const callOpts = {
      messages,
      temperature: 0.1,
      response_format: responseFormat,
    };

    const result = args.model
      ? await ctx.client.chatDirect({ model: args.model, allow_paid: args.allow_paid, ...callOpts })
      : await ctx.client.chatChain({
          chain: chainFor('extract'),
          allow_paid: args.allow_paid,
          ...callOpts,
        });

    if (!result.ok) return toolResult(result.envelope);

    let data: unknown;
    try {
      data = JSON.parse(result.content);
    } catch (parseErr) {
      const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return toolResult(
        error({
          code: 'INVALID_INPUT',
          message: `extract: model returned non-JSON content: ${message}`,
          suggested_action:
            'The model violated structured-output constraints. Retry; consider falling back to query_free with a stricter prompt.',
        }),
      );
    }

    if (!args.allow_missing) {
      const missing = findMissingRequired(args.schema, data);
      if (missing) {
        return toolResult(
          error({
            code: 'INVALID_INPUT',
            message: `extract: required field missing or null at path '${missing}'.`,
            suggested_action:
              'Either set allow_missing: true to accept null values, or revise the source text / schema so the field is present.',
          }),
        );
      }
    }

    return toolResult(
      success({
        result: data,
        model_used: result.model_used,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        finish_reason: result.finish_reason,
        fallback_chain: result.fallback_chain,
        cost_usd: result.cost_usd,
      }),
    );
  } catch (e) {
    return toolResult(unknownError(e, 'extract'));
  }
}
