import { describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/extract.js';
import { OpenRouterClient } from '../src/client.js';
import type { ToolContext } from '../src/types.js';

const ctx = { client: new OpenRouterClient({ apiKey: 'test-key' }) };

describe('extract input validation', () => {
  it('rejects missing text', async () => {
    const res = await handler({ schema: { type: 'object' } }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects missing schema', async () => {
    const res = await handler({ text: 'some text' }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects non-object schema', async () => {
    const res = await handler({ text: 'hi', schema: 'not an object' }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects empty text', async () => {
    const res = await handler({ text: '', schema: { type: 'object' } }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects schema that exceeds MAX_SCHEMA_BYTES with INVALID_INPUT', async () => {
    // Build a schema whose JSON serialisation exceeds 100 000 bytes.
    const hugeSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 500 }, (_, i) => [
          `field_${i}`,
          { type: 'string', description: 'x'.repeat(200) },
        ]),
      ),
    };
    const res = await handler({ text: 'hi', schema: hugeSchema }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });
});

describe('extract — happy path', () => {
  function stubCtx(content: string) {
    const chain = vi.fn().mockResolvedValue({
      ok: true as const,
      content,
      model_used: 'free/primary',
      tokens_in: 20,
      tokens_out: 10,
      finish_reason: 'stop',
      fallback_chain: ['free/primary'],
      cost_usd: 0,
    });
    const tctx: ToolContext = {
      client: { chatChain: chain, chatDirect: vi.fn() } as unknown as ToolContext['client'],
    };
    return { ctx: tctx, chain };
  }

  const simpleSchema = {
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'number' } },
  };

  it('routes through chatChain and returns parsed JSON result', async () => {
    const { ctx: tctx } = stubCtx('{"name": "Alice", "age": 30}');
    const res = await handler({ text: 'Alice is 30.', schema: simpleSchema }, tctx);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.result).toEqual({ name: 'Alice', age: 30 });
    expect(env.model_used).toBe('free/primary');
  });

  it('passes response_format json_schema to the chatChain call', async () => {
    const { ctx: tctx, chain } = stubCtx('{"name": "Bob"}');
    await handler({ text: 'Bob.', schema: simpleSchema }, tctx);
    const callArgs = chain.mock.calls[0]![0] as { response_format: { type: string; json_schema: { strict: boolean; name: string; schema: unknown } } };
    expect(callArgs.response_format.type).toBe('json_schema');
    expect(callArgs.response_format.json_schema.strict).toBe(true);
    expect(callArgs.response_format.json_schema.name).toBe('extraction');
    expect(callArgs.response_format.json_schema.schema).toEqual(simpleSchema);
  });

  it('returns INVALID_INPUT when model returns non-JSON content', async () => {
    const { ctx: tctx } = stubCtx('not json at all');
    const res = await handler({ text: 'hi', schema: simpleSchema }, tctx);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(env.error.message).toContain('non-JSON');
  });

  it('returns INVALID_INPUT when required field is null and allow_missing: false', async () => {
    const { ctx: tctx } = stubCtx('{"name": null}');
    const schemaWithRequired = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    };
    const res = await handler({ text: 'no name here', schema: schemaWithRequired, allow_missing: false }, tctx);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(env.error.message).toContain('name');
  });

  it('allows null required field when allow_missing: true (default)', async () => {
    const { ctx: tctx } = stubCtx('{"name": null}');
    const schemaWithRequired = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    };
    const res = await handler({ text: 'no name', schema: schemaWithRequired }, tctx);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.result).toEqual({ name: null });
  });

  it('routes through chatDirect when model is set', async () => {
    const direct = vi.fn().mockResolvedValue({
      ok: true as const, content: '{"name": "Carol"}', model_used: 'paid/model',
      tokens_in: 10, tokens_out: 5, finish_reason: 'stop', fallback_chain: ['paid/model'], cost_usd: 0.001,
    });
    const tctx: ToolContext = {
      client: { chatChain: vi.fn(), chatDirect: direct } as unknown as ToolContext['client'],
    };
    const res = await handler({ text: 'Carol.', schema: simpleSchema, model: 'paid/model', allow_paid: true }, tctx);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.result).toEqual({ name: 'Carol' });
    expect(direct).toHaveBeenCalledTimes(1);
  });
});
