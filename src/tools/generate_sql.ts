/**
 * generate_sql — produce a SQL query from a schema and natural-language intent.
 *
 * Routes through the `code` task chain. The system prompt instructs the model
 * to output ONLY the SQL — no commentary, no fences. We do NOT execute the
 * query; correctness against the schema is the caller's responsibility.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { composeMessages } from '../prompt.js';
import { chainFor } from '../models.js';
import type { ToolContext } from '../types.js';

const DIALECT_NOTES: Record<'postgres' | 'mysql' | 'sqlite' | 'bigquery' | 'mssql', string> = {
  postgres: 'PostgreSQL — use standard SQL with PG-specific functions where helpful (e.g. ILIKE, ::cast, generate_series).',
  mysql: 'MySQL — use backticks for identifiers when needed, and prefer LIMIT over FETCH FIRST.',
  sqlite: 'SQLite — keep to the SQLite-supported subset; avoid functions like NOW() (use CURRENT_TIMESTAMP).',
  bigquery: 'BigQuery — use Standard SQL, backticked fully-qualified table names, and STRUCT/ARRAY types where idiomatic.',
  mssql: 'Microsoft SQL Server (T-SQL) — use TOP for limits, square-bracket identifiers, and GETDATE() for current time.',
};

export const definition = {
  name: 'generate_sql',
  description:
    'Generate a SQL query from a schema and a natural-language intent via a curated free code-tuned model. Returns ONLY the SQL — no commentary or fences. We do NOT execute the query; verify against the schema yourself. Use for read queries against a single schema. NOT for: cross-DB joins, vendor-specific window-function gymnastics, or destructive write/DDL where review is mandatory — use Claude directly there.',
  inputSchema: {
    type: 'object',
    properties: {
      schema: {
        type: 'string',
        description: 'DDL or schema description that grounds the model. Include relevant table names, columns, and types.',
      },
      intent: {
        type: 'string',
        description: 'What the query should do, in plain language.',
      },
      dialect: {
        type: 'string',
        enum: ['postgres', 'mysql', 'sqlite', 'bigquery', 'mssql'],
        description: 'SQL dialect. Default postgres.',
        default: 'postgres',
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
    required: ['schema', 'intent'],
  },
};

const Args = z.object({
  schema: z.string().min(1),
  intent: z.string().min(1),
  dialect: z.enum(['postgres', 'mysql', 'sqlite', 'bigquery', 'mssql']).default('postgres'),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

export async function handler(rawArgs: unknown, ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `generate_sql invalid input: ${parsed.error.message}`,
        suggested_action: 'Verify schema and intent are non-empty and dialect is in the enum.',
      }),
    );
  }
  const args = parsed.data;

  const system = `You are a SQL expert generating a query for ${args.dialect}. ${DIALECT_NOTES[args.dialect]} Output ONLY the SQL query — no explanation, no commentary, no markdown code fences, no preamble. The output will be sent directly to the database driver.`;

  const instruction = `Schema:\n${args.schema}\n\nIntent: ${args.intent}\n\nWrite a single ${args.dialect} query that satisfies the intent. SQL only.`;

  const messages = composeMessages({
    system,
    instruction,
  });

  try {
    if (args.model) {
      const result = await ctx.client.chatDirect({
        model: args.model,
        messages,
        max_tokens: 2048,
        temperature: 0.1,
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
      temperature: 0.1,
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
    return toolResult(unknownError(e, 'generate_sql'));
  }
}
