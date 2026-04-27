import { describe, expect, it } from 'vitest';

import { isTrulyFree } from '../src/probe.js';

describe('isTrulyFree (the pricing trap check)', () => {
  it('returns true when ALL pricing fields are zero', () => {
    expect(
      isTrulyFree({
        prompt: 0,
        completion: 0,
        image_output: 0,
        audio: 0,
        video_output: 0,
        request: 0,
      }),
    ).toBe(true);
  });

  it('returns false when image_output is non-zero (the UI hides this!)', () => {
    expect(
      isTrulyFree({
        prompt: 0,
        completion: 0,
        image_output: 0.04, // Seedream-style — UI shows $0/$0 in token columns
        audio: 0,
        video_output: 0,
        request: 0,
      }),
    ).toBe(false);
  });

  it('returns false when audio is non-zero (TTS models)', () => {
    expect(
      isTrulyFree({
        prompt: 0,
        completion: 0,
        image_output: 0,
        audio: 0.0000006,
        video_output: 0,
        request: 0,
      }),
    ).toBe(false);
  });

  it('returns false when video_output is non-zero', () => {
    expect(
      isTrulyFree({
        prompt: 0,
        completion: 0,
        image_output: 0,
        audio: 0,
        video_output: 0.03,
        request: 0,
      }),
    ).toBe(false);
  });

  it('returns false when prompt is non-zero', () => {
    expect(
      isTrulyFree({
        prompt: 0.0000003,
        completion: 0,
        image_output: 0,
        audio: 0,
        video_output: 0,
        request: 0,
      }),
    ).toBe(false);
  });

  it('returns false when request (flat per-call) is non-zero', () => {
    expect(
      isTrulyFree({
        prompt: 0,
        completion: 0,
        image_output: 0,
        audio: 0,
        video_output: 0,
        request: 0.001,
      }),
    ).toBe(false);
  });
});
