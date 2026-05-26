import { describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/classify.js';
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

function stubCtx(chainContent: string) {
  const chain = vi.fn().mockResolvedValue(okChain(chainContent));
  const tctx: ToolContext = {
    client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
  };
  return { ctx: tctx, chain };
}

describe('classify input validation', () => {
  it('rejects when neither text nor items is provided', async () => {
    const res = await handler({ labels: ['a', 'b'] }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects when both text and items are provided', async () => {
    const res = await handler(
      { text: 'hi', items: ['a'], labels: ['x', 'y'] },
      ctx,
    );
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects when labels has fewer than 2 entries', async () => {
    const res = await handler({ text: 'hi', labels: ['only'] }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects when labels is missing', async () => {
    const res = await handler({ text: 'hi' }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });
});

describe('classify — happy path', () => {
  it('returns label for single text item', async () => {
    const { ctx: tctx } = stubCtx('{"labels": ["positive"]}');
    const res = await handler({ text: 'I love this!', labels: ['positive', 'negative'] }, tctx);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.result.results[0].labels).toEqual(['positive']);
    expect(env.model_used).toBe('free/primary');
  });

  it('retries with stricter prompt when first attempt returns a hallucinated label', async () => {
    const chain = vi.fn()
      .mockResolvedValueOnce(okChain('{"labels": ["unknown_label"]}'))
      .mockResolvedValueOnce(okChain('{"labels": ["positive"]}'));
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    const res = await handler({ text: 'great', labels: ['positive', 'negative'] }, tctx);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.result.results[0].labels).toEqual(['positive']);
    expect(chain).toHaveBeenCalledTimes(2);
  });

  it('returns INVALID_INPUT after both attempts return hallucinated labels', async () => {
    const chain = vi.fn()
      .mockResolvedValueOnce(okChain('{"labels": ["bad1"]}'))
      .mockResolvedValueOnce(okChain('{"labels": ["bad2"]}'));
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    const res = await handler({ text: 'hi', labels: ['a', 'b'] }, tctx);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(env.error.message).toContain('Stricter retry also failed');
    expect(chain).toHaveBeenCalledTimes(2);
  });

  it('fans out to one chatChain call per item in batch mode', async () => {
    const chain = vi.fn().mockResolvedValue(okChain('{"labels": ["a"]}'));
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    await handler({ items: ['item1', 'item2', 'item3'], labels: ['a', 'b'] }, tctx);
    expect(chain).toHaveBeenCalledTimes(3);
  });

  it('includes rationale in result when rationale: true', async () => {
    const { ctx: tctx } = stubCtx('{"labels": ["positive"], "rationale": "Clearly positive tone."}');
    const res = await handler(
      { text: 'great!', labels: ['positive', 'negative'], rationale: true },
      tctx,
    );
    const env = JSON.parse(res.content[0]!.text);
    expect(env.result.results[0].rationale).toBe('Clearly positive tone.');
  });

  it('returns INVALID_INPUT when model returns multiple labels but multi_label is false', async () => {
    const { ctx: tctx } = stubCtx('{"labels": ["positive", "negative"]}');
    const res = await handler({ text: 'ambiguous text', labels: ['positive', 'negative'] }, tctx);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(env.error.message).toContain('multi_label');
  });

  it('routes through chatDirect when model is set', async () => {
    const direct = vi.fn().mockResolvedValue(okChain('{"labels": ["positive"]}'));
    const chain = vi.fn();
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: direct } as unknown as ToolContext['client'],
    };
    await handler({ text: 'hi', labels: ['positive', 'negative'], model: 'some/model' }, tctx);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(chain).not.toHaveBeenCalled();
  });
});
