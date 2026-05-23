/**
 * analyze_image — visual reasoning over an image.
 *
 * Routes through the `analyze_image` task chain. Free primary is
 * google/gemma-4-31b-it (vision-reasoning tuned), with gemma-4-26b-a4b-it
 * (MoE vision) as fallback.
 *
 * Use for UI mockup interpretation, diagram understanding, chart reading,
 * screenshot debugging — anything where you ask a question ABOUT the image
 * rather than just reading text from it. For pure text extraction use
 * `extract_text` (specialist OCR model).
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { chainFor } from '../models.js';
import { wrapUntrusted } from '../prompt.js';
import { MAX_BASE64_BYTES, validateUserUrl } from '../security.js';
import type { ChatRequest, ToolContext } from '../types.js';

const IMAGE_INPUT_REGEX = /^(https:\/\/.+|data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)$/;

export const definition = {
  name: 'analyze_image',
  description:
    "Visual reasoning over an image — UI mockup interpretation, diagram understanding, chart reading, screenshot debugging, 'what error is shown?', 'describe this UI flow'. NOT for: pure text extraction (use extract_text — its specialist OCR model is more accurate for transcription).",
  inputSchema: {
    type: 'object',
    properties: {
      image: {
        type: 'string',
        description:
          "Image input. Either an https:// URL, or a data URL like 'data:image/png;base64,iVBOR...'.",
      },
      prompt: {
        type: 'string',
        description:
          "What to analyze, e.g. 'What error is shown?' or 'Describe this UI flow.' or 'What does this chart suggest about Q3 revenue?'",
      },
      model: {
        type: 'string',
        description: 'Optional explicit model override. Bypasses the curated chain.',
      },
      allow_paid: {
        type: 'boolean',
        description:
          'Allow escalation to a cheap paid vision model when free fallbacks fail. Default false.',
        default: false,
      },
    },
    required: ['image', 'prompt'],
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
  prompt: z.string().min(1),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

function buildMessages(image: string, prompt: string): ChatRequest['messages'] {
  const system =
    'You are a careful visual analyst. Look at the image and answer the user\'s question directly and concretely. Do not include preamble like "Sure, here is..." — output the analysis only.';

  // Wrap the user's question — it's untrusted content (could itself contain
  // injection attempts targeted at the smaller vision model).
  const userText = wrapUntrusted(prompt);

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
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
        message: `analyze_image invalid input: ${parsed.error.message}`,
        suggested_action:
          "Verify image is an https URL or 'data:image/...;base64,...' data URL, and prompt is non-empty.",
      }),
    );
  }
  const args = parsed.data;

  const messages = buildMessages(args.image, args.prompt);

  try {
    if (args.model) {
      const result = await ctx.client.chatDirect({
        model: args.model,
        messages,
        max_tokens: 2048,
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

    const chain = chainFor('analyze_image');
    const result = await ctx.client.chatChain({
      chain,
      messages,
      max_tokens: 2048,
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
    return toolResult(unknownError(e, 'analyze_image'));
  }
}
