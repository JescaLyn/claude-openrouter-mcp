/**
 * read_pdf — extract and answer questions about a PDF document.
 *
 * Uses OpenRouter's `file-parser` plugin to extract PDF text on the
 * upstream side, then routes the resulting text + question to a free
 * chat model for Q&A.
 *
 * Engines:
 *   - 'cloudflare-ai' (default, free): markdown extraction. Loses fidelity
 *     on tables/math/multi-column.
 *   - 'mistral-ocr' (paid, $2/1K pages): higher-fidelity for scanned/complex
 *     PDFs. Requires allow_paid: true; otherwise tool returns
 *     PAID_CONFIRMATION_REQUIRED.
 *
 * Plugins are passed via the client's `extra` passthrough — `extra.plugins`
 * is splatted into the request body alongside the typed params.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { chainFor } from '../models.js';
import { wrapUntrusted } from '../prompt.js';
import type { ChatRequest, ToolContext } from '../types.js';

const PDF_INPUT_REGEX = /^(https?:\/\/.+|data:application\/pdf;base64,[A-Za-z0-9+/=]+)$/;

const ENGINE_COSTS = {
  'cloudflare-ai': {
    paid: false,
    note: 'cloudflare-ai · free markdown extraction',
  },
  'mistral-ocr': {
    paid: true,
    note: 'mistral-ocr · ~$2 per 1K pages (high-fidelity scanned-PDF OCR)',
  },
} as const;

export const definition = {
  name: 'read_pdf',
  description:
    "Extract and answer questions about a PDF document. Default engine 'cloudflare-ai' is free (markdown extraction; loses fidelity on tables/math/multi-column). For scanned or complex layouts, set engine: 'mistral-ocr' (paid, ~$2/1K pages, requires allow_paid: true). The chat model used after extraction defaults to a free workhorse; override with `model` if needed.",
  inputSchema: {
    type: 'object',
    properties: {
      pdf: {
        type: 'string',
        description:
          "PDF input. Either an https:// URL, or a data URL like 'data:application/pdf;base64,...'.",
      },
      prompt: {
        type: 'string',
        description: "Question or extraction task, e.g. 'Summarize this PDF' or 'Extract the table on page 3'.",
      },
      engine: {
        type: 'string',
        enum: ['cloudflare-ai', 'mistral-ocr'],
        description:
          "PDF parsing engine. 'cloudflare-ai' (free, default) is markdown extraction. 'mistral-ocr' is paid (~$2/1K pages, requires allow_paid: true) and best for scanned/complex layouts.",
        default: 'cloudflare-ai',
      },
      model: {
        type: 'string',
        description:
          'Optional chat model used after extraction. Defaults to the curated read_pdf primary (a free workhorse).',
      },
      allow_paid: {
        type: 'boolean',
        description:
          "Required when engine='mistral-ocr' or when overriding `model` to a paid id. When false and engine is paid, returns PAID_CONFIRMATION_REQUIRED with cost estimate.",
        default: false,
      },
    },
    required: ['pdf', 'prompt'],
  },
};

const Args = z.object({
  pdf: z
    .string()
    .min(1)
    .regex(
      PDF_INPUT_REGEX,
      "pdf must be an https URL or a 'data:application/pdf;base64,...' data URL",
    ),
  prompt: z.string().min(1),
  engine: z.enum(['cloudflare-ai', 'mistral-ocr']).default('cloudflare-ai'),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

function buildMessages(pdf: string, prompt: string): ChatRequest['messages'] {
  const system =
    'You are answering questions about a PDF document. The document content is provided as a file attachment. Answer the user\'s question concretely; cite page numbers when present. No preamble like "Sure, here is..." — output the answer only.';

  const userText = wrapUntrusted(prompt);

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        {
          type: 'file',
          file: { filename: 'document.pdf', file_data: pdf },
        },
      ],
    },
  ];
}

export async function handler(rawArgs: unknown, ctx: ToolContext) {
  const parsed = Args.safeParse(rawArgs);
  if (!parsed.success) {
    return toolResult(
      error({
        code: 'INVALID_INPUT',
        message: `read_pdf invalid input: ${parsed.error.message}`,
        suggested_action:
          "Verify pdf is an https URL or 'data:application/pdf;base64,...' data URL, prompt is non-empty, and engine is one of 'cloudflare-ai' | 'mistral-ocr'.",
      }),
    );
  }
  const args = parsed.data;

  // Paid-engine gate: surface PAID_CONFIRMATION_REQUIRED before making any call.
  const engineMeta = ENGINE_COSTS[args.engine];
  if (engineMeta.paid && !args.allow_paid) {
    return toolResult(
      error({
        code: 'PAID_CONFIRMATION_REQUIRED',
        message: `Engine '${args.engine}' is paid (${engineMeta.note}). Approval required.`,
        retryable: true,
        suggested_action:
          "Retry with allow_paid: true to use the paid engine, or switch engine to 'cloudflare-ai' (free).",
        cost_breakdown: engineMeta.note,
      }),
    );
  }

  const messages = buildMessages(args.pdf, args.prompt);

  // file-parser plugin config — splatted into the request body via `extra`.
  const extra = {
    plugins: [
      {
        id: 'file-parser',
        pdf: { engine: args.engine },
      },
    ],
  };

  try {
    if (args.model) {
      const result = await ctx.client.chatDirect({
        model: args.model,
        messages,
        max_tokens: 2048,
        temperature: 0.3,
        extra,
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

    const chain = chainFor('read_pdf');
    const result = await ctx.client.chatChain({
      chain,
      messages,
      max_tokens: 2048,
      temperature: 0.3,
      allow_paid: args.allow_paid,
      extra,
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
    return toolResult(unknownError(e, 'read_pdf'));
  }
}
