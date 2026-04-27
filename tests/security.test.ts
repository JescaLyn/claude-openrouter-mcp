import { describe, expect, it } from 'vitest';

import { isOpenRouterHost, validateUserUrl } from '../src/security.js';

describe('validateUserUrl', () => {
  it('accepts data: URIs unconditionally', () => {
    expect(validateUserUrl('data:image/png;base64,iVBORw0...').ok).toBe(true);
    expect(validateUserUrl('data:application/pdf;base64,JVBERi0...').ok).toBe(true);
    expect(validateUserUrl('data:audio/mp3;base64,SUQzBAA...').ok).toBe(true);
  });

  it('accepts public https URLs', () => {
    expect(validateUserUrl('https://example.com/foo.png').ok).toBe(true);
    expect(validateUserUrl('https://images.example.org/path?q=1').ok).toBe(true);
  });

  it('rejects http: (downgrade)', () => {
    const r = validateUserUrl('http://example.com/foo.png');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/scheme.*not allowed/);
  });

  it('rejects file:, ftp:, gopher:', () => {
    expect(validateUserUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateUserUrl('ftp://files.example.com/foo').ok).toBe(false);
    expect(validateUserUrl('gopher://example.com/').ok).toBe(false);
  });

  it('rejects localhost and .local hosts (SSRF)', () => {
    expect(validateUserUrl('https://localhost/admin').ok).toBe(false);
    expect(validateUserUrl('https://service.local/').ok).toBe(false);
    expect(validateUserUrl('https://api.internal/').ok).toBe(false);
    expect(validateUserUrl('https://machine.lan/').ok).toBe(false);
  });

  it('rejects private/loopback IPv4 (SSRF)', () => {
    // AWS IMDS — the canonical SSRF target.
    expect(validateUserUrl('https://169.254.169.254/latest/meta-data/').ok).toBe(false);
    // RFC 1918 ranges.
    expect(validateUserUrl('https://10.0.0.1/').ok).toBe(false);
    expect(validateUserUrl('https://192.168.1.1/').ok).toBe(false);
    expect(validateUserUrl('https://172.16.0.1/').ok).toBe(false);
    expect(validateUserUrl('https://172.31.255.255/').ok).toBe(false);
    // Loopback.
    expect(validateUserUrl('https://127.0.0.1/').ok).toBe(false);
    // 0.x is reserved.
    expect(validateUserUrl('https://0.0.0.0/').ok).toBe(false);
  });

  it('allows public IPv4 in 172.x ranges OUTSIDE 16-31', () => {
    expect(validateUserUrl('https://172.32.0.1/').ok).toBe(true);
    expect(validateUserUrl('https://172.15.0.1/').ok).toBe(true);
  });

  it('rejects IPv6 loopback and link-local', () => {
    expect(validateUserUrl('https://[::1]/').ok).toBe(false);
    expect(validateUserUrl('https://[fe80::1]/').ok).toBe(false);
    expect(validateUserUrl('https://[fc00::1]/').ok).toBe(false);
  });

  it('rejects garbage', () => {
    expect(validateUserUrl('').ok).toBe(false);
    expect(validateUserUrl('not a url').ok).toBe(false);
    expect(validateUserUrl('javascript:alert(1)').ok).toBe(false);
  });
});

describe('isOpenRouterHost', () => {
  it('accepts only https://openrouter.ai', () => {
    expect(isOpenRouterHost('https://openrouter.ai/api/v1/videos/foo')).toBe(true);
    expect(isOpenRouterHost('https://openrouter.ai/')).toBe(true);
  });

  it('rejects subdomains', () => {
    expect(isOpenRouterHost('https://api.openrouter.ai/foo')).toBe(false);
    expect(isOpenRouterHost('https://evil.openrouter.ai/foo')).toBe(false);
  });

  it('rejects http://', () => {
    expect(isOpenRouterHost('http://openrouter.ai/foo')).toBe(false);
  });

  it('rejects unrelated hosts', () => {
    expect(isOpenRouterHost('https://attacker.example.com/foo')).toBe(false);
    expect(isOpenRouterHost('https://or/v1/videos/foo')).toBe(false);
  });

  it('rejects garbage', () => {
    expect(isOpenRouterHost('not a url')).toBe(false);
    expect(isOpenRouterHost('')).toBe(false);
  });
});
