/**
 * Public reader authentication. Clients send `Authorization: Bearer <key>` (or `x-api-key`).
 *
 * Keys are compared in constant time. The key itself never reaches a log line or the upstream
 * request: the gateway authenticates at the edge and talks to the worker with its own token.
 */

export interface AuthResult {
  ok: boolean;
  /** Stable, non-reversible identifier for the presented key — used to bucket rate limits. */
  bucket: string;
  error?: { code: 'unauthorized' | 'forbidden'; message: string };
}

/** FNV-1a over the key: enough to bucket traffic without ever storing or logging the secret. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function presentedKey(request: Request): { value: string; via: 'bearer' | 'api-key' } | null {
  const authorization = request.headers.get('authorization') ?? '';
  if (authorization.toLowerCase().startsWith('bearer ')) {
    const value = authorization.slice(7).trim();
    if (value.length > 0) return { value, via: 'bearer' };
  }
  const apiKey = request.headers.get('x-api-key') ?? '';
  if (apiKey.trim().length > 0) return { value: apiKey.trim(), via: 'api-key' };
  return null;
}

/** Length-independent constant time comparison. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}

export function authenticate(
  request: Request,
  options: { keys: string[]; required: boolean },
): AuthResult {
  const presented = presentedKey(request);
  if (options.keys.length === 0) {
    if (!options.required) return { ok: true, bucket: 'anonymous' };
    return {
      ok: false,
      bucket: 'anonymous',
      error: { code: 'forbidden', message: 'the API is not configured with any reader keys' },
    };
  }
  if (!presented) {
    return {
      ok: false,
      bucket: 'anonymous',
      error: { code: 'unauthorized', message: 'missing API key' },
    };
  }
  const matched = options.keys.some((key) => constantTimeEqual(key, presented.value));
  if (!matched) {
    return {
      ok: false,
      bucket: 'anonymous',
      error: { code: 'unauthorized', message: 'invalid API key' },
    };
  }
  return { ok: true, bucket: `key:${fingerprint(presented.value)}` };
}

export const ANONYMOUS_BUCKET = 'anon';

/** Client identity for rate limiting: the first proxy address, falling back to a static bucket. */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first && first.length <= 64) return first;
  }
  const cf = request.headers.get('cf-connecting-ips');
  if (cf) {
    const first = cf.split(',')[0]?.trim();
    if (first && first.length <= 64) return first;
  }
  return 'unknown';
}
