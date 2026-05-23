/**
 * analyze_video — frame-sampled visual analysis of a short video clip.
 *
 * Routes through the `analyze_video` task chain. Free primary is
 * nvidia/nemotron-nano-12b-v2-vl. Frames are sampled at fps_hint frames
 * per second by the upstream model; practical max length is 60-120s on
 * free tier (longer clips blow the context window).
 *
 * IMPORTANT: this does NOT transcribe audio. Frame-only analysis means
 * scene description, action recognition, and visible text/UI reading.
 * For speech transcription, use the (paid) `transcribe` tool — separate path.
 */

import { z } from 'zod';

import { error, success, toolResult, unknownError } from '../envelope.js';
import { chainFor } from '../models.js';
import { wrapUntrusted } from '../prompt.js';
import { MAX_BASE64_BYTES, validateUserUrl } from '../security.js';
import type { ChatRequest, ToolContext } from '../types.js';

// URL or data:video/...;base64,...
const VIDEO_INPUT_REGEX = /^(https:\/\/.+|data:video\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)$/;

export const definition = {
  name: 'analyze_video',
  description:
    'Frame-sampled visual analysis of a short video clip. Use for action recognition, scene description, visible-text reading from screen recordings, or UI walkthroughs (60-120s practical max on free tier; longer clips will fail or be heavily downsampled). NOT for: transcribing speech in video — frames only, audio is NOT processed. Use the paid `transcribe` tool on the audio track separately.',
  inputSchema: {
    type: 'object',
    properties: {
      video: {
        type: 'string',
        description:
          "Video input. Either an https:// URL, or a data URL like 'data:video/mp4;base64,...'.",
      },
      prompt: {
        type: 'string',
        description:
          "What to analyze, e.g. 'Describe what happens in this clip' or 'What error appears on screen?'",
      },
      fps_hint: {
        type: 'integer',
        description:
          'Frame sampling rate hint (frames per second). Higher = more detail but more context cost. Defaults to 1.',
        default: 1,
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
    required: ['video', 'prompt'],
  },
};

const Args = z.object({
  video: z
    .string()
    .min(1)
    .max(MAX_BASE64_BYTES, `video data URI exceeds ${MAX_BASE64_BYTES} byte cap`)
    .regex(VIDEO_INPUT_REGEX, 'video must be an https URL or a data:video/...;base64,... data URL')
    .refine((s) => validateUserUrl(s).ok, (s) => ({
      message: validateUserUrl(s).reason ?? 'video URL rejected',
    })),
  prompt: z.string().min(1),
  fps_hint: z.number().int().positive().max(30).default(1),
  model: z.string().optional(),
  allow_paid: z.boolean().default(false),
});

function buildMessages(video: string, prompt: string, fps_hint: number): ChatRequest['messages'] {
  const system = [
    'You are a careful visual analyst working with a frame-sampled video clip.',
    `Frames are sampled at approximately ${fps_hint} frame${fps_hint === 1 ? '' : 's'} per second.`,
    'Describe what is visible across the frames. You CANNOT hear audio — do not speculate about speech.',
    'Answer the user\'s question directly. No preamble like "Sure, here is..." — output the analysis only.',
  ].join(' ');

  const userText = wrapUntrusted(prompt);

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'video_url', video_url: { url: video } },
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
        message: `analyze_video invalid input: ${parsed.error.message}`,
        suggested_action:
          "Verify video is an https URL or 'data:video/...;base64,...' data URL, prompt is non-empty, and fps_hint is between 1 and 30.",
      }),
    );
  }
  const args = parsed.data;

  const messages = buildMessages(args.video, args.prompt, args.fps_hint);

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

    const chain = chainFor('analyze_video');
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
    return toolResult(unknownError(e, 'analyze_video'));
  }
}
