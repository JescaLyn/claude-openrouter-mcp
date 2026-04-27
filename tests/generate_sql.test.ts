/**
 * Input-validation tests for generate_sql.
 */

import { describe, expect, it, vi } from 'vitest';

import { handler } from '../src/tools/generate_sql.js';
import type { ToolContext } from '../src/types.js';

function stubCtx() {
  return {
    client: {
      chatChain: vi.fn().mockResolvedValue({
        ok: true,
        content: 'SELECT 1;',
        model_used: 'free/primary',
        tokens_in: 10,
        tokens_out: 5,
        finish_reason: 'stop',
        fallback_chain: ['free/primary'],
        cost_usd: 0,
      }),
      chatDirect: vi.fn(),
    } as unknown as ToolContext['client'],
  };
}

function envelope(out: { content: Array<{ text: string }> }) {
  return JSON.parse(out.content[0]!.text);
}

describe('generate_sql handler', () => {
  it('rejects missing schema', async () => {
    const out = await handler({ intent: 'count rows' }, stubCtx());
    expect(envelope(out).error.code).toBe('INVALID_INPUT');
  });

  it('rejects missing intent', async () => {
    const out = await handler({ schema: 'CREATE TABLE t (id INT);' }, stubCtx());
    expect(envelope(out).error.code).toBe('INVALID_INPUT');
  });

  it('rejects an out-of-enum dialect', async () => {
    const out = await handler(
      { schema: 'CREATE TABLE t (id INT);', intent: 'count', dialect: 'oracle' },
      stubCtx(),
    );
    expect(envelope(out).error.code).toBe('INVALID_INPUT');
  });

  it('returns success with valid args', async () => {
    const out = await handler(
      { schema: 'CREATE TABLE t (id INT);', intent: 'count rows', dialect: 'sqlite' },
      stubCtx(),
    );
    const env = envelope(out);
    expect(env.result).toBe('SELECT 1;');
  });
});
