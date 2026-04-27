import { describe, expect, it } from 'vitest';

import { handler } from '../src/tools/translate.js';
import { OpenRouterClient } from '../src/client.js';

const ctx = { client: new OpenRouterClient({ apiKey: 'test-key' }) };

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
