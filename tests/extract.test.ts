import { describe, expect, it } from 'vitest';

import { handler } from '../src/tools/extract.js';
import { OpenRouterClient } from '../src/client.js';

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
});
