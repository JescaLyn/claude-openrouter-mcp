/**
 * Security helpers — URL validation, host allowlisting, size caps.
 *
 * The threat model: caller-supplied URLs reach OpenRouter (and OpenRouter then
 * fetches them on behalf of the user). Without validation, this becomes a
 * second-order SSRF — a prompt-injected `image_url` of `http://169.254.169.254/`
 * (AWS IMDS), `http://localhost/admin`, or any RFC 1918 host gets fetched by
 * OpenRouter. Local box isn't probed, but the user is using OpenRouter as a
 * confused-deputy fetcher against their own internal services.
 *
 * Mitigation: https-only, reject loopback / private / link-local hosts.
 */

const PRIVATE_IPV4_PATTERNS = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
];

function isPrivateIPv4(host: string): boolean {
  return PRIVATE_IPV4_PATTERNS.some((re) => re.test(host));
}

function isLoopbackOrLocalIPv6(host: string): boolean {
  // Strip brackets if present.
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  // Loopback ::1, link-local fe80::/10, unique local fc00::/7
  return h === '::1' || /^fe[89ab][0-9a-f]?:/i.test(h) || /^f[cd][0-9a-f]{2}:/i.test(h);
}

function isLocalHostname(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.lan')
  );
}

export interface UrlValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a user-supplied URL or data-URI for safe forwarding to OpenRouter.
 *
 * Allowed:
 *   - data: URLs (any mime type) — caller embeds bytes directly
 *   - https: URLs to non-private hosts
 *
 * Rejected:
 *   - http: (downgrade attack surface; OpenRouter only ever serves https anyway)
 *   - file:, ftp:, gopher:, etc.
 *   - https://localhost, https://*.local, https://*.internal
 *   - https://10.x, https://127.x, https://169.254.x, https://172.16-31.x, https://192.168.x
 *   - https://[::1], https://[fe80::*], https://[fc00::*]
 */
export function validateUserUrl(input: string): UrlValidationResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: 'URL is empty.' };
  }

  if (input.startsWith('data:')) {
    // Data URIs carry their own bytes; nothing to fetch.
    return { ok: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, reason: 'URL is not parseable.' };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: `URL scheme '${parsed.protocol}' is not allowed; use https or a data: URI.`,
    };
  }

  const host = parsed.hostname;
  if (isLocalHostname(host)) {
    return { ok: false, reason: `Host '${host}' is a local hostname; not allowed.` };
  }
  if (isPrivateIPv4(host)) {
    return { ok: false, reason: `Host '${host}' is a private/loopback IPv4 address; not allowed.` };
  }
  if (host.includes(':') || (host.startsWith('[') && host.endsWith(']'))) {
    if (isLoopbackOrLocalIPv6(host)) {
      return {
        ok: false,
        reason: `Host '${host}' is a loopback/link-local/unique-local IPv6 address; not allowed.`,
      };
    }
  }

  return { ok: true };
}

/**
 * Check that a URL's host is exactly openrouter.ai. Used to validate
 * server-returned polling URLs before attaching our bearer token to them
 * — a redirect or compromised response could otherwise exfiltrate the key.
 */
export function isOpenRouterHost(input: string): boolean {
  try {
    const parsed = new URL(input);
    return parsed.protocol === 'https:' && parsed.hostname === 'openrouter.ai';
  } catch {
    return false;
  }
}

/**
 * Cap on the size of base64-encoded media inputs. ~50 MB base64 = ~37 MB raw,
 * which is enough for typical screenshots, short audio clips, short videos,
 * and modest PDFs while protecting the server from accidental megafiles.
 */
export const MAX_BASE64_BYTES = 50_000_000;

/**
 * Cap on the JSON-stringified size of a user-supplied JSON Schema in `extract`.
 * Deeply nested or `$ref`-cycled schemas can DOS the strict-mode validator.
 */
export const MAX_SCHEMA_BYTES = 100_000;
