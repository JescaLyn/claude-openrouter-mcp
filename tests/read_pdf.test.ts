/**
 * Input-validation tests for read_pdf, plus an integration test that wires
 * the real OpenRouterClient to a fetch spy to verify the file-parser plugin
 * config lands in the request body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenRouterClient } from '../src/client.js';
import { handler } from '../src/tools/read_pdf.js';
import type { ToolContext } from '../src/types.js';

function stubCtx() {
  const chatChain = vi.fn().mockResolvedValue({
    ok: true,
    content: 'PDF says hello.',
    model_used: 'openai/gpt-oss-120b',
    tokens_in: 100,
    tokens_out: 10,
    finish_reason: 'stop',
    fallback_chain: ['openai/gpt-oss-120b'],
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

describe('read_pdf handler — input validation', () => {
  it('rejects missing pdf with INVALID_INPUT', async () => {
    const { ctx } = stubCtx();
    const env = envelope(await handler({ prompt: 'summarize' }, ctx));
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects an image data URL passed as pdf', async () => {
    const { ctx } = stubCtx();
    const env = envelope(
      await handler(
        { pdf: 'data:image/png;base64,abc=', prompt: 'summarize' },
        ctx,
      ),
    );
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects unknown engine value', async () => {
    const { ctx } = stubCtx();
    const env = envelope(
      await handler(
        {
          pdf: 'https://example.com/doc.pdf',
          prompt: 'summarize',
          engine: 'wishful-ai',
        },
        ctx,
      ),
    );
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it("returns PAID_CONFIRMATION_REQUIRED when engine='mistral-ocr' and allow_paid is false", async () => {
    const { ctx, chatChain } = stubCtx();
    const env = envelope(
      await handler(
        {
          pdf: 'https://example.com/scan.pdf',
          prompt: 'summarize',
          engine: 'mistral-ocr',
        },
        ctx,
      ),
    );
    expect(env.error.code).toBe('PAID_CONFIRMATION_REQUIRED');
    expect(env.error.cost_breakdown).toContain('mistral-ocr');
    // No upstream call when paid gate trips.
    expect(chatChain).not.toHaveBeenCalled();
  });

  it('surfaces upstream error from chatChain as-is', async () => {
    const errorChain = vi.fn().mockResolvedValue({
      ok: false,
      envelope: { error: { code: 'UPSTREAM_HTTP', message: 'upstream failed', retryable: true } },
      fallback_chain: ['free/primary'],
    });
    const errorCtx: ToolContext = {
      client: { chatChain: errorChain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    const env = envelope(
      await handler({ pdf: 'https://example.com/doc.pdf', prompt: 'summarize' }, errorCtx),
    );
    expect(env.error.code).toBe('UPSTREAM_HTTP');
  });

  it('passes file-parser plugin config in extra to the client', async () => {
    const { ctx, chatChain } = stubCtx();
    await handler(
      {
        pdf: 'data:application/pdf;base64,JVBERi0xLjQK',
        prompt: 'summarize',
      },
      ctx,
    );
    const callArgs = chatChain.mock.calls[0]?.[0] as {
      extra?: { plugins?: Array<{ id: string; pdf?: { engine: string } }> };
    };
    expect(callArgs.extra?.plugins).toBeDefined();
    expect(callArgs.extra?.plugins?.[0]?.id).toBe('file-parser');
    expect(callArgs.extra?.plugins?.[0]?.pdf?.engine).toBe('cloudflare-ai');
  });
});

describe('read_pdf — file-parser plugin lands in real request body', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let client: OpenRouterClient;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'extracted answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    client = new OpenRouterClient({ apiKey: 'test-key' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends plugins:[{id:"file-parser", pdf:{engine}}] in the body', async () => {
    const ctx: ToolContext = { client };
    await handler(
      {
        pdf: 'data:application/pdf;base64,JVBERi0xLjQK',
        prompt: 'What is in this PDF?',
      },
      ctx,
    );

    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.plugins).toEqual([
      { id: 'file-parser', pdf: { engine: 'cloudflare-ai' } },
    ]);
    // Sanity: the user message has the file content block.
    const userMsg = body.messages[body.messages.length - 1];
    expect(userMsg.role).toBe('user');
    const fileBlock = userMsg.content.find((b: { type: string }) => b.type === 'file');
    expect(fileBlock).toBeDefined();
    expect(fileBlock.file.filename).toBe('document.pdf');
    expect(fileBlock.file.file_data).toBe('data:application/pdf;base64,JVBERi0xLjQK');
  });
});
