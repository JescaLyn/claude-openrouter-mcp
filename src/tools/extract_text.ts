/**
 * extract_text — OCR (image → verbatim text).
 *
 * Routes through the `extract_text` task chain. Free primary is
 * baidu/qianfan-ocr-fast — a specialist OCR model that beats general
 * vision models on transcription accuracy (#1 OmniDocBench v1.5).
 *
 * Builds a multimodal user message (text + image_url block) directly
 * instead of going through composeMessages, which only handles plain text.
 *
 * For visual reasoning ("what does this UI do?", "what error is shown?"),
 * use `analyze_image` instead — that routes to a vision-reasoning model.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { chainFor } from '../models.js';
import { MAX_BASE64_BYTES, validateUserUrl } from '../security.js';
import type { ChatRequest, ToolContext } from '../types.js';

// URL or data:image/...;base64,...
const IMAGE_INPUT_REGEX = /^(https?:\/\/.+|data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)$/;

export const definition = {
  name: 'extract_text',
  description:
    "Extract text verbatim from an image (OCR). Use for screenshots of code/error messages, photos of documents, OCR of UI captures, or any case where you need the literal text content. Specialist OCR model (Qianfan-OCR-Fast) is better than the visual-reasoning model for pure transcription. NOT for: visual reasoning, chart interpretation, or 'what is shown?' questions — use analyze_image instead.",
  inputSchema: {
    type: 'object',
    properties: {
      image: {
        type: 'string',
        description:
          "Image input. Either an https:// URL, or a data URL like 'data:image/png;base64,iVBOR...'. Must be one of those two shapes.",
      },
      language_hint: {
        type: 'string',
        description:
          "Optional language hint. Improves accuracy for non-Latin scripts (e.g. 'Chinese', 'Arabic', 'Japanese').",
      },
      preserve_layout: {
        type: 'boolean',
        description:
          'If true, attempts to preserve spatial layout (columns, tables, indentation). Slower but useful for tabular or multi-column content. Defaults to false.',
        default: false,
      },
      model: {
        type: 'string',
        description: 'Optional explicit model override. Bypasses the curated chain.',
      },
      allow_paid: {
        type: 'boolean',
        description:
          'Allow escalation to a cheap paid vision model when free fallbacks fail. Default false; tool returns PAID_CONFIRMATION_REQUIRED first.',
        default: false,
      },
    },
    required: ['image'],
  },
};

const Args = z.object({
  image: z
    .string()
    .min(1)
    .max(MAX_BASE64_BYTES, `image data URI exceeds ${MAX_BASE64_BYTES} byte cap`)
    .regex(IMAGE_INPUT_REGEX, 'image must be an https URL or a data:image/...;base64,... data URL')
    .refine((s) => validateUserUrl(s).ok, (s) => ({
      message: validateUserUrl(s).reason ?? 'image URL rejected',
    })),
  language_hint: z.string().optional(),
  preserve_layout: z.boolean().default(false),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

function buildSystemPrompt(language_hint: string | undefined, preserve_layout: boolean): string {
  const parts: string[] = [
    'You are an OCR transcription engine.',
    'Transcribe the text visible in the image verbatim.',
    'Do NOT summarize, paraphrase, translate, or add commentary.',
    'Do NOT include preamble like "Here is the text:" — output only the transcribed text.',
  ];
  if (language_hint) {
    parts.push(`The text is primarily in: ${language_hint}.`);
  }
  if (preserve_layout) {
    parts.push(
      'Preserve the spatial layout: keep columns aligned, retain table structure, and use line breaks to mirror the source. Use whitespace to approximate the visual arrangement.',
    );
  } else {
    parts.push('Reading order is normal top-to-bottom, left-to-right.');
  }
  return parts.join(' ');
}

function buildMessages(image: string, system: string): ChatRequest['messages'] {
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Transcribe all text visible in this image.' },
        { type: 'image_url', image_url: { url: image } },
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
        message: `extract_text invalid input: ${parsed.error.message}`,
        suggested_action:
          "Verify image is an https URL or 'data:image/...;base64,...' data URL.",
      }),
    );
  }
  const args = parsed.data;

  const system = buildSystemPrompt(args.language_hint, args.preserve_layout);
  const messages = buildMessages(args.image, system);

  try {
    if (args.model) {
      const result = await ctx.client.chatDirect({
        model: args.model,
        messages,
        max_tokens: 4096,
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

    const chain = chainFor('extract_text');
    const result = await ctx.client.chatChain({
      chain,
      messages,
      max_tokens: 4096,
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
    return toolResult(unknownError(e, 'extract_text'));
  }
}
