import { describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/rewrite.js';
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

describe('rewrite input validation', () => {
  it('rejects missing text', async () => {
    const res = await handler({ instruction: 'tighten' }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects missing instruction', async () => {
    const res = await handler({ text: 'hi' }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects preserve value outside the enum', async () => {
    const res = await handler(
      { text: 'hi', instruction: 'tighten', preserve: ['code', 'voodoo'] },
      ctx,
    );
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects empty instruction', async () => {
    const res = await handler({ text: 'hi', instruction: '' }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });
});

describe('rewrite — happy path', () => {
  it('routes through chatChain and returns rewritten text', async () => {
    const chain = vi.fn().mockResolvedValue(okChain('Shorter text.'));
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    const res = await handler({ text: 'This is a very long sentence that needs shortening.', instruction: 'tighten' }, tctx);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.result).toBe('Shorter text.');
    expect(env.model_used).toBe('free/primary');
  });

  it('includes preserve clauses in the system prompt', async () => {
    const chain = vi.fn().mockResolvedValue(okChain('result'));
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    await handler({ text: 'x = 42.', instruction: 'tighten', preserve: ['code', 'numbers'] }, tctx);
    const callArgs = chain.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    const sysMsg = callArgs.messages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toContain('code spans');
    expect(sysMsg?.content).toContain('numeric values');
  });

  it('routes through chatDirect when model is set', async () => {
    const direct = vi.fn().mockResolvedValue(okChain('result'));
    const chain = vi.fn();
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: direct } as unknown as ToolContext['client'],
    };
    await handler({ text: 'hi', instruction: 'tighten', model: 'some/model' }, tctx);
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
    const res = await handler({ text: 'some text', instruction: 'tighten' }, tctx);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.error.code).toBe('UPSTREAM_HTTP');
  });
});
