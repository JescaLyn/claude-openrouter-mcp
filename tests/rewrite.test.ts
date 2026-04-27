import { describe, expect, it } from 'vitest';

import { handler } from '../src/tools/rewrite.js';
import { OpenRouterClient } from '../src/client.js';

const ctx = { client: new OpenRouterClient({ apiKey: 'test-key' }) };

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
