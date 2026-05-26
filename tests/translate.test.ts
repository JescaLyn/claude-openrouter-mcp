import { describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/translate.js';
import { OpenRouterClient } from '../src/client.js';
import type { ToolContext } from '../src/types.js';

const ctx = { client: new OpenRouterClient({ apiKey: 'test-key' }) };

function okChain(content: string) {
  return {
    ok: true as const,
    content,
    model_used: 'free/primary',
    tokens_in: 10,
    tokens_out: 5,
    finish_reason: 'stop',
    fallback_chain: ['free/primary'],
    cost_usd: 0,
  };
}

describe('translate input validation', () => {
  it('rejects missing text', async () => {
    const res = await handler({ target_lang: 'es' }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects missing target_lang', async () => {
    const res = await handler({ text: 'hello' }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects tone outside the enum', async () => {
    const res = await handler({ text: 'hi', target_lang: 'es', tone: 'snarky' }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects empty text', async () => {
    const res = await handler({ text: '', target_lang: 'es' }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });
});

describe('translate — happy path', () => {
  it('routes through chatChain and returns translated text', async () => {
    const chain = vi.fn().mockResolvedValue(okChain('Hola mundo.'));
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    const res = await handler({ text: 'Hello world.', target_lang: 'es' }, tctx);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.result).toBe('Hola mundo.');
    expect(env.model_used).toBe('free/primary');
  });

  it('formal tone appears in the system prompt', async () => {
    const chain = vi.fn().mockResolvedValue(okChain('result'));
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    await handler({ text: 'hi', target_lang: 'de', tone: 'formal' }, tctx);
    const callArgs = chain.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    const sysMsg = callArgs.messages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toContain('formal');
  });

  it('source_lang is included in the system prompt when provided', async () => {
    const chain = vi.fn().mockResolvedValue(okChain('result'));
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    await handler({ text: 'hi', target_lang: 'fr', source_lang: 'en' }, tctx);
    const callArgs = chain.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    const sysMsg = callArgs.messages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toContain('en');
  });

  it('routes through chatDirect when model is set', async () => {
    const direct = vi.fn().mockResolvedValue(okChain('result'));
    const chain = vi.fn();
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: direct } as unknown as ToolContext['client'],
    };
    await handler({ text: 'hi', target_lang: 'ja', model: 'some/model' }, tctx);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(chain).not.toHaveBeenCalled();
  });

  it('surfaces upstream error from chatChain as-is', async () => {
    const chain = vi.fn().mockResolvedValue({
      ok: false,
      envelope: { error: { code: 'UPSTREAM_HTTP', message: 'upstream failed', retryable: true } },
      fallback_chain: ['free/primary'],
    });
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    const res = await handler({ text: 'hello', target_lang: 'es' }, tctx);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.error.code).toBe('UPSTREAM_HTTP');
  });
});
