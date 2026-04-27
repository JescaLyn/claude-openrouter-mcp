/**
 * Input-validation tests for analyze_video.
 */

import { describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/analyze_video.js';
import type { ToolContext } from '../src/types.js';

function stubCtx() {
  const chatChain = vi.fn().mockResolvedValue({
    ok: true,
    content: 'A user clicks Submit and a toast appears.',
    model_used: 'nvidia/nemotron-nano-12b-v2-vl',
    tokens_in: 200,
    tokens_out: 30,
    finish_reason: 'stop',
    fallback_chain: ['nvidia/nemotron-nano-12b-v2-vl'],
    cost_usd: 0,
  });
  const ctx: ToolContext = {
    client: {
      chatChain,
      chatDirect: vi.fn(),
    } as unknown as ToolContext['client'],
  };
  return { ctx, chatChain };
}

function envelope(out: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(out.content[0]!.text);
}

describe('analyze_video handler', () => {
  it('rejects missing video with INVALID_INPUT', async () => {
    const { ctx } = stubCtx();
    const env = envelope(await handler({ prompt: 'describe' }, ctx));
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects an image data URL passed as video', async () => {
    const { ctx } = stubCtx();
    const env = envelope(
      await handler(
        { video: 'data:image/png;base64,abc=', prompt: 'describe' },
        ctx,
      ),
    );
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects fps_hint > 30', async () => {
    const { ctx } = stubCtx();
    const env = envelope(
      await handler(
        {
          video: 'https://example.com/clip.mp4',
          prompt: 'what happens?',
          fps_hint: 60,
        },
        ctx,
      ),
    );
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('routes valid input through analyze_video chain with a video block', async () => {
    const { ctx, chatChain } = stubCtx();
    const env = envelope(
      await handler(
        {
          video: 'https://example.com/clip.mp4',
          prompt: 'What happens in the clip?',
        },
        ctx,
      ),
    );
    expect(env.result).toBe('A user clicks Submit and a toast appears.');
    const callArgs = chatChain.mock.calls[0]?.[0] as { messages: unknown[] };
    const userMsg = callArgs.messages[callArgs.messages.length - 1] as {
      role: string;
      content: Array<{ type: string; video_url?: { url: string } }>;
    };
    expect(userMsg.role).toBe('user');
    const videoBlock = userMsg.content.find((b) => b.type === 'video_url');
    expect(videoBlock?.video_url?.url).toBe('https://example.com/clip.mp4');
  });
});
