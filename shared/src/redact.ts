/**
 * Secret redaction. Applied to every log line, error message and API response field we do not
 * fully control. Proxy credentials in particular must never reach stdout, error trackers or the
 * public API.
 */

/** Field names whose values are always redacted, no matter how short. */
export const SECRET_KEY_PATTERN =
  /(^|[_-])(pass(word|wd)?|secret|token|authorization|api[-_]?key|apikey|access[-_]?key|private[-_]?key|client[-_]?secret|credential(s)?|cookie|set-cookie|session|password2|auth)([_-]|$)/i;

/** Field names that may contain credentials inside their value. */
const TEXT_FIELD_PATTERN =
  /(url|href|uri|target|endpoint|proxy|address|location|server|authority|dsn|connection)/i;

const URL_CREDENTIALS_RE = /([a-z][a-z0-9+.-]{0,15}:\/\/)([^/@\s]*?:[^/@\s]*@)/gi;
const QUERY_SECRET_RE = /([?&](?:[^=&#]*(?:password|token|secret|key|sig|auth)[^=&#]*)=)([^&#]*)/gi;
const BEARER_RE = /\b(bearer|basic|digest|token)\s+[a-z0-9._~+/=-]{6,}/gi;
const KEY_VALUE_RE =
  /\b((?:password|passwd|pwd|secret|token|api_key|apikey|access_key|auth|cookie|authorization)["']?\s*[:=]\s*)(["']?)([^\s"',;}&]{3,})\2/gi;

export const REDACTED = '[redacted]';

function looksLikeCredentialText(value: string): boolean {
  return (
    URL_CREDENTIALS_RE.test(value) ||
    QUERY_SECRET_RE.test(value) ||
    BEARER_RE.test(value) ||
    KEY_VALUE_RE.test(value)
  );
}

/** Redacts credentials embedded in URLs (`socks5://user:pass@host` -> `socks5://***@host`). */
export function redactUrl(input: string): string {
  let out = input.replace(URL_CREDENTIALS_RE, (_m, scheme: string) => `${scheme}${REDACTED}@`);
  out = out.replace(QUERY_SECRET_RE, (_m, prefix: string) => `${prefix}${REDACTED}`);
  out = out.replace(BEARER_RE, (_m, kind: string) => `${kind} ${REDACTED}`);
  return out;
}

/** Redacts `key: value` / `key=value` credential pairs in free text (logs, upstream errors). */
export function redactText(input: string): string {
  let out = redactUrl(input);
  out = out.replace(
    KEY_VALUE_RE,
    (_m, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`,
  );
  return out;
}

function shortHash(value: string): string {
  // Deterministic, non-reversible fingerprint so operators can still correlate secrets.
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `len=${value.length} fnv=${h.toString(16).padStart(8, '0')}`;
}

/**
 * Recursively sanitizes a value for logging. Keeps structure, replaces anything that looks like
 * a credential with `[redacted]` plus a length/fingerprint so operators can debug without leaking.
 */
export function redactValue(value: unknown, keyHint?: string): unknown {
  if (value === null || value === undefined) return value;
  if (keyHint && SECRET_KEY_PATTERN.test(keyHint)) {
    return typeof value === 'string' && value.length > 0
      ? `${REDACTED} (${shortHash(value)})`
      : REDACTED;
  }
  if (typeof value === 'string') {
    if (keyHint && TEXT_FIELD_PATTERN.test(keyHint)) return redactText(value);
    return looksLikeCredentialText(value) ? redactText(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return value;
  if (value instanceof Error) {
    const code = (value as Error & { code?: unknown }).code;
    return {
      name: value.name,
      message: redactText(value.message),
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((item) => redactValue(item, keyHint));
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source).slice(0, 64)) {
      out[key] = redactValue(item, key);
    }
    return out;
  }
  return String(value);
}

export function redactObject<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return redactValue(input) as Record<string, unknown>;
}
