import { describe, expect, it } from 'vitest';

import { error, success, toolResult, unknownError } from '../src/envelope.js';
import { isErrorEnvelope } from '../src/types.js';

describe('envelope', () => {
  it('success() builds the spec-conformant shape with sensible defaults', () => {
    const env = success({
      result: 'hello',
      model_used: 'foo/bar:free',
      tokens_in: 10,
      tokens_out: 5,
    });
    expect(env.result).toBe('hello');
    expect(env.model_used).toBe('foo/bar:free');
    expect(env.usage).toEqual({ tokens_in: 10, tokens_out: 5 });
    expect(env.finish_reason).toBe('stop');
    expect(env.fallback_chain).toEqual(['foo/bar:free']);
    expect(env.cost_usd).toBe(0);
  });

  it('error() includes optional cost fields only when set', () => {
    const minimal = error({
      code: 'INVALID_INPUT',
      message: 'bad',
      suggested_action: 'fix it',
    });
    expect(minimal.error.code).toBe('INVALID_INPUT');
    expect(minimal.error.retryable).toBe(false);
    expect('estimated_cost_usd' in minimal.error).toBe(false);
    expect('cost_breakdown' in minimal.error).toBe(false);

    const paid = error({
      code: 'PAID_CONFIRMATION_REQUIRED',
      message: 'paid',
      retryable: true,
      suggested_action: 'retry with allow_paid',
      estimated_cost_usd: 0.031,
      cost_breakdown: 'foo · 1MP × $0.030',
      suggested_paid_model: 'flux.2-pro',
    });
    expect(paid.error.estimated_cost_usd).toBe(0.031);
    expect(paid.error.cost_breakdown).toBe('foo · 1MP × $0.030');
    expect(paid.error.suggested_paid_model).toBe('flux.2-pro');
  });

  it('isErrorEnvelope discriminates correctly', () => {
    expect(isErrorEnvelope(success({ result: 'x', model_used: 'm' }))).toBe(false);
    expect(
      isErrorEnvelope(error({ code: 'UPSTREAM_HTTP', message: 'm', suggested_action: 'a' })),
    ).toBe(true);
  });

  it('toolResult() wraps an error envelope with isError: true', () => {
    const wrapped = toolResult(
      error({ code: 'UPSTREAM_HTTP', message: 'm', suggested_action: 'a' }),
    );
    expect(wrapped.isError).toBe(true);
    expect(wrapped.content[0]?.type).toBe('text');
    const parsed = JSON.parse(wrapped.content[0]!.text);
    expect(parsed.error.code).toBe('UPSTREAM_HTTP');
  });

  it('toolResult() does NOT set isError on success', () => {
    const wrapped = toolResult(success({ result: 'x', model_used: 'm' }));
    expect('isError' in wrapped).toBe(false);
  });

  it('unknownError() converts arbitrary throwns to UPSTREAM_HTTP', () => {
    const env = unknownError(new Error('boom'), 'test_stage');
    expect(env.error.code).toBe('UPSTREAM_HTTP');
    expect(env.error.message).toContain('test_stage');
    expect(env.error.message).toContain('boom');
    expect(env.error.retryable).toBe(true);
  });
});
