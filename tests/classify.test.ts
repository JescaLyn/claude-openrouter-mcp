import { describe, expect, it } from 'vitest';

import { handler } from '../src/tools/classify.js';
import { OpenRouterClient } from '../src/client.js';

const ctx = { client: new OpenRouterClient({ apiKey: 'test-key' }) };

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
