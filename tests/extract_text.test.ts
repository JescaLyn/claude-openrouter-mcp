/**
 * Input-validation tests for extract_text.
 */

import { describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/extract_text.js';
import type { ToolContext } from '../src/types.js';

function stubCtx() {
  const chatChain = vi.fn().mockResolvedValue({
    ok: true,
    content: 'transcribed text',
    model_used: 'baidu/qianfan-ocr-fast',
    tokens_in: 5,
    tokens_out: 10,
    finish_reason: 'stop',
    fallback_chain: ['baidu/qianfan-ocr-fast'],
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

describe('extract_text handler', () => {
  it('rejects missing image with INVALID_INPUT', async () => {
    const { ctx } = stubCtx();
    const env = envelope(await handler({}, ctx));
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects an image that is neither URL nor data URL', async () => {
    const { ctx } = stubCtx();
    const env = envelope(await handler({ image: '/etc/passwd' }, ctx));
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('accepts an https URL and routes through extract_text chain', async () => {
    const { ctx, chatChain } = stubCtx();
    const env = envelope(
      await handler({ image: 'https://example.com/page.png' }, ctx),
    );
    expect(env.result).toBe('transcribed text');
    expect(env.model_used).toBe('baidu/qianfan-ocr-fast');
    expect(chatChain).toHaveBeenCalledTimes(1);
  });

  it('builds a multimodal message with text + image_url blocks', async () => {
    const { ctx, chatChain } = stubCtx();
    await handler(
      {
        image: 'data:image/png;base64,iVBORw0KGgo=',
        language_hint: 'Japanese',
        preserve_layout: true,
      },
      ctx,
    );
    const callArgs = chatChain.mock.calls[0]?.[0] as { messages: unknown[] };
    expect(callArgs).toBeDefined();
    expect(callArgs.messages.length).toBeGreaterThanOrEqual(2);
    const userMsg = callArgs.messages[callArgs.messages.length - 1] as {
      role: string;
      content: Array<{ type: string; image_url?: { url: string } }>;
    };
    expect(userMsg.role).toBe('user');
    expect(Array.isArray(userMsg.content)).toBe(true);
    const types = userMsg.content.map((b) => b.type);
    expect(types).toContain('text');
    expect(types).toContain('image_url');
    const imageBlock = userMsg.content.find((b) => b.type === 'image_url');
    expect(imageBlock?.image_url?.url).toBe('data:image/png;base64,iVBORw0KGgo=');
  });
});
