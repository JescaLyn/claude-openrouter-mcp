import { describe, expect, it } from 'vitest';

import { handler } from '../src/tools/summarize.js';
import { OpenRouterClient } from '../src/client.js';

const ctx = { client: new OpenRouterClient({ apiKey: 'test-key' }) };

describe('summarize input validation', () => {
  it('rejects missing text', async () => {
    const res = await handler({}, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects empty text', async () => {
    const res = await handler({ text: '' }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects style outside the enum', async () => {
    const res = await handler({ text: 'hi', style: 'verbose' }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });

  it('rejects negative max_chars', async () => {
    const res = await handler({ text: 'hi', max_chars: -10 }, ctx);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.error.code).toBe('INVALID_INPUT');
  });
});
