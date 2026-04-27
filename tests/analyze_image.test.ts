/**
 * Input-validation tests for analyze_image.
 */

import { describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/analyze_image.js';
import type { ToolContext } from '../src/types.js';

function stubCtx() {
  const chatChain = vi.fn().mockResolvedValue({
    ok: true,
    content: 'I see a login screen with an error.',
    model_used: 'google/gemma-4-31b-it',
    tokens_in: 50,
    tokens_out: 25,
    finish_reason: 'stop',
    fallback_chain: ['google/gemma-4-31b-it'],
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

describe('analyze_image handler', () => {
  it('rejects missing image with INVALID_INPUT', async () => {
    const { ctx } = stubCtx();
    const env = envelope(await handler({ prompt: 'describe' }, ctx));
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects missing prompt with INVALID_INPUT', async () => {
    const { ctx } = stubCtx();
    const env = envelope(
      await handler({ image: 'https://example.com/x.png' }, ctx),
    );
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects malformed image (file path)', async () => {
    const { ctx } = stubCtx();
    const env = envelope(
      await handler({ image: '/path/to/file.png', prompt: 'what?' }, ctx),
    );
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('passes valid args and builds a multimodal user message with the image block', async () => {
    const { ctx, chatChain } = stubCtx();
    const env = envelope(
      await handler(
        {
          image: 'https://example.com/screenshot.png',
          prompt: 'What error is shown?',
        },
        ctx,
      ),
    );
    expect(env.result).toBe('I see a login screen with an error.');
    const callArgs = chatChain.mock.calls[0]?.[0] as { messages: unknown[] };
    const userMsg = callArgs.messages[callArgs.messages.length - 1] as {
      role: string;
      content: Array<{ type: string; image_url?: { url: string } }>;
    };
    expect(userMsg.role).toBe('user');
    const imageBlock = userMsg.content.find((b) => b.type === 'image_url');
    expect(imageBlock?.image_url?.url).toBe('https://example.com/screenshot.png');
  });
});
