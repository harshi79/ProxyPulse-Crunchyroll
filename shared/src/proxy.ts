/**
 * Proxy entry normalization.
 *
 * Public proxy lists are wildly inconsistent, so this module is deliberately forgiving on
 * *shape* and strict on *validity*. It never applies network/security policy (see ip.ts +
 * the worker's endpoint guard) and never emits credentials into any returned string.
 */

import {
  type AnonymityLevel,
  type ProxyEndpoint,
  type ProxyProtocol,
  isProxyProtocol,
} from './types.js';

export const MAX_ENTRY_LENGTH = 256;
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const DIGITS_RE = /^\d{1,5}$/;
const COUNTRY_RE = /^[a-z]{2}$/;
const CREDENTIAL_CHARSET_RE = /^[\x21-\x7e ]+$/;

/** Schemes accepted on input, mapped onto the canonical protocol set. */
const PROTOCOL_ALIASES: Record<string, ProxyProtocol> = {
  http: 'http',
  https: 'https',
  tls: 'https',
  socks4: 'socks4',
  socks4a: 'socks4',
  socks5: 'socks5',
  socks5h: 'socks5',
  socks: 'socks5',
};

/** Default ports used only for inference/formatting, never for validation. */
export const DEFAULT_PORT_FOR_PROTOCOL: Record<ProxyProtocol, number> = {
  http: 80,
  https: 443,
  socks4: 1080,
  socks5: 1080,
};

export type ParseFailureReason =
  | 'empty'
  | 'too_long'
  | 'no_port'
  | 'invalid_port'
  | 'invalid_host'
  | 'invalid_scheme'
  | 'unsupported_protocol'
  | 'invalid_credentials'
  | 'ambiguous_format'
  | 'ipv6_requires_brackets'
  | 'not_an_entry';

export interface NormalizedProxy extends ProxyEndpoint {
  /** Two letter country code when the source exposed one. */
  country?: string | undefined;
  anonymity: AnonymityLevel;
}

export type ProtocolSource = 'scheme' | 'hint' | 'default';

export interface ParseSuccess {
  ok: true;
  proxy: NormalizedProxy;
  protocol_source: ProtocolSource;
}

export interface ParseFailure {
  ok: false;
  reason: ParseFailureReason;
  message: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

export interface ParseOptions {
  /**
   * Protocol to assume when the entry itself carries no scheme, e.g. a "SOCKS5" block in a list.
   * An explicit scheme in the entry always wins over the hint.
   */
  protocolHint?: ProxyProtocol | undefined;
  /** Applied when a source advertises its protocol without a scheme (defaults to http). */
  defaultProtocol?: ProxyProtocol | undefined;
  /** Keep `anonymity`/`country` fields that appear after the credentials (source dependent). */
  strictCredentials?: boolean | undefined;
}

const fail = (reason: ParseFailureReason, message: string): ParseFailure => ({
  ok: false,
  reason,
  message,
});

/** Cheap heuristic for "this line is a page/JSON blob, not a proxy entry". */
const MARKUP_RE = /<\/?[a-z][a-z0-9]*[\s/>]/i;
export function looksLikeMarkup(line: string): boolean {
  const value = line.trim();
  if (value.length === 0) return false;
  if (MARKUP_RE.test(value)) return true;
  const first = value[0];
  return (
    first === '{' || first === '[' || value.startsWith('<?xml') || value.startsWith('<!doctype')
  );
}

/** Detects the protocol implied by a bare label such as `socks5` or `HTTP proxies:`. */
export function detectProtocolFromLabel(label: string): ProxyProtocol | null {
  const token = label.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (token.startsWith('socks4')) return 'socks4';
  if (token.startsWith('socks5') || token === 'socks') return 'socks5';
  if (token.startsWith('https')) return 'https';
  if (token.startsWith('http')) return 'http';
  return null;
}

const IPV4_LIKE_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function validHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  // IPv6 must be bracketed in URL-like forms; by the time we get here brackets are stripped.
  if (host.includes(':')) return false;
  if (!HOSTNAME_RE.test(host)) return false;
  // `256.300.1.1` passes a generic hostname regex but is not a usable address: an entry that looks
  // like IPv4 has to *be* IPv4.
  if (IPV4_LIKE_RE.test(host)) return host.split('.').every((octet) => Number(octet) <= 255);
  return true;
}

function normalizeHost(raw: string): string | null {
  let host = raw.trim();
  if (host.length === 0) return null;
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1);
    // Bracketed IPv6: keep as-is (lowercased, zone id dropped) — validated in ip.ts.
    const withoutZone = inner.split('%')[0] ?? '';
    return withoutZone.includes(':') ? withoutZone.toLowerCase() : null;
  }
  host = host.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1); // strip root dot
  if (host.length === 0) return null;
  if (host.includes(':')) return null; // bare IPv6 without brackets
  if (host.includes('/') || host.includes('?') || host.includes('#')) return null;
  return validHost(host) ? host : null;
}

function normalizePort(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (!DIGITS_RE.test(value)) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return null;
  return port;
}

function cleanCredential(raw: string, allowColon: boolean): string | null {
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    /* keep raw value when it is not percent encoded */
  }
  if (value.length === 0 || value.length > 128) return null;
  if (!CREDENTIAL_CHARSET_RE.test(value)) return null;
  if (!allowColon && value.includes(':')) return null;
  if (value.includes('@')) return null;
  return value;
}

/** Splits `user@host` style userinfo from the authority part. */
function splitUserinfo(authority: string): {
  user: string | null;
  pass: string | null;
  host: string;
} {
  const at = authority.lastIndexOf('@');
  if (at === -1) return { user: null, pass: null, host: authority };
  const userinfo = authority.slice(0, at);
  const host = authority.slice(at + 1);
  const colon = userinfo.indexOf(':');
  if (colon === -1) return { user: userinfo, pass: null, host };
  return { user: userinfo.slice(0, colon), pass: userinfo.slice(colon + 1), host };
}

/**
 * Parses one proxy entry.
 *
 * Accepts (and documents) these shapes:
 *   host:port
 *   host port
 *   host:port:user:pass[:cc]
 *   user:pass@host:port
 *   protocol://host:port
 *   protocol://user:pass@host:port
 *   [ipv6]:port / protocol://[ipv6]:port
 */
export function parseProxyEntry(input: string, options: ParseOptions = {}): ParseResult {
  const raw = input.trim();
  if (raw.length === 0) return fail('empty', 'entry is empty');
  if (raw.length > MAX_ENTRY_LENGTH)
    return fail('too_long', `entry exceeds ${MAX_ENTRY_LENGTH} characters`);
  if (/[\r\n\t]/.test(raw)) return fail('ambiguous_format', 'entry contains control characters');
  if (looksLikeMarkup(raw))
    return fail('not_an_entry', 'entry looks like markup or structured data');

  let protocol: ProxyProtocol | null = null;
  let protocol_source: ProtocolSource = 'default';
  let authority = raw;

  const schemeMatch = /^([a-z][a-z0-9+.-]{0,15}):\/\//i.exec(raw);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? '').toLowerCase();
    const mapped = PROTOCOL_ALIASES[scheme];
    if (!mapped) return fail('invalid_scheme', `unsupported scheme "${scheme}"`);
    protocol = mapped;
    protocol_source = 'scheme';
    authority = raw.slice((schemeMatch[0] ?? '').length);
    if (authority.length === 0) return fail('invalid_host', 'missing host after scheme');
  } else if (/^[a-z][a-z0-9+.-]{0,15}:/i.test(raw) && !raw.includes('@')) {
    // e.g. `socks5:1.2.3.4:1080` (scheme without slashes)
    const candidate = raw.slice(0, raw.indexOf(':')).toLowerCase();
    const mapped = PROTOCOL_ALIASES[candidate];
    if (mapped) {
      protocol = mapped;
      protocol_source = 'scheme';
      authority = raw.slice(candidate.length + 1);
    } else {
      return fail('invalid_scheme', `unsupported scheme "${candidate}"`);
    }
  }

  if (authority.includes('/')) {
    const withoutPath = authority.split('/')[0] ?? '';
    if (withoutPath !== authority) authority = withoutPath; // tolerate `host:port/`
  }
  if (authority.includes('?') || authority.includes('#')) {
    return fail('ambiguous_format', 'entry looks like a URL, not a proxy endpoint');
  }

  const { user, pass, host: hostPart } = splitUserinfo(authority);
  if (user !== null || pass !== null) {
    if (hostPart.includes(' ') || hostPart.trim().length === 0)
      return fail('invalid_host', 'invalid host');
  }

  let host: string | null;
  let port: number | null;
  let inlineUser: string | null = null;
  let inlinePass: string | null = null;
  let country: string | undefined;

  const bracketed = /^\[[^\]]+\]/.test(hostPart);

  if (user !== null || pass !== null) {
    host = normalizeHost(hostPart.split(':')[0] ?? '');
    port = hostPart.startsWith('[')
      ? normalizePort(hostPart.slice(hostPart.indexOf(']') + 1).replace(/^:/, ''))
      : normalizePort(hostPart.split(':').slice(1).join(':'));
    inlineUser = user;
    inlinePass = pass;
  } else if (!bracketed && hostPart.includes(' ') && !hostPart.includes(':')) {
    const [h, p] = hostPart.split(/\s+/);
    host = normalizeHost(h ?? '');
    port = normalizePort(p);
  } else if (!bracketed) {
    const parts = hostPart.split(':');
    // An unbracketed IPv6 (>= 4 purely hexagonal fields) is a common list mistake: report it as
    // such instead of misreading it as `host:port:user:pass`.
    const looksLikeUnbracketedIpv6 =
      parts.length >= 5 &&
      parts.every((part) => part.length === 0 || /^[0-9a-f]{1,4}$/i.test(part)) &&
      (parts.includes('') || parts.length >= 7);
    if (looksLikeUnbracketedIpv6) {
      return fail('ipv6_requires_brackets', 'IPv6 hosts need [brackets]');
    }
    if (parts.length === 2) {
      host = normalizeHost(parts[0] ?? '');
      port = normalizePort(parts[1]);
    } else if (parts.length === 4 || parts.length === 5) {
      host = normalizeHost(parts[0] ?? '');
      port = normalizePort(parts[1]);
      if ((parts[2] ?? '').length === 0) {
        return fail('ambiguous_format', 'empty username in host:port:user:pass layout');
      }
      inlineUser = parts[2] ?? null;
      inlinePass = parts[3] ?? null;
      const maybeCc = parts[4];
      if (maybeCc !== undefined) {
        if (!COUNTRY_RE.test(maybeCc.toLowerCase())) {
          return fail('ambiguous_format', 'unexpected trailing field after credentials');
        }
        country = maybeCc.toUpperCase();
      }
    } else if (parts.length === 3 && /^\[[0-9a-f:]+\]$/i.test(parts[0] ?? '')) {
      return fail('ambiguous_format', 'unexpected IPv6 field layout');
    } else if (parts.length === 3) {
      return fail('ambiguous_format', 'expected host:port or host:port:user:pass');
    } else if (parts.length === 1) {
      host = normalizeHost(parts[0] ?? '');
      if (host === null) {
        return fail(
          raw.includes(':') ? 'ipv6_requires_brackets' : 'invalid_host',
          'host is not a valid hostname or IPv4 address',
        );
      }
      return fail('no_port', 'missing port');
    } else {
      // 6+ colon-separated fields without brackets is almost always an unbracketed IPv6.
      const isIpv6ish = parts.length > 5 && parts.every((p) => /^[0-9a-f]+$/i.test(p));
      return fail(
        isIpv6ish ? 'ipv6_requires_brackets' : 'ambiguous_format',
        isIpv6ish ? 'IPv6 hosts need [brackets]' : 'too many ":" separated fields',
      );
    }
  } else {
    const close = hostPart.indexOf(']');
    host = normalizeHost(hostPart.slice(0, close + 1));
    port = normalizePort(hostPart.slice(close + 1).replace(/^:/, ''));
  }

  if (host === null) return fail('invalid_host', `invalid host "${hostPart}"`);
  if (port === null) {
    const authorityAfterHost = hostPart.startsWith('[')
      ? hostPart.slice(hostPart.indexOf(']') + 1)
      : hostPart.slice(hostPart.indexOf(':') + 1);
    const hasPortToken = hostPart.includes(':') || hostPart.includes(']');
    return fail(
      hasPortToken && authorityAfterHost.trim().length > 0 ? 'invalid_port' : 'no_port',
      `missing or invalid port in "${hostPart}"`,
    );
  }

  let username: string | undefined;
  let password: string | undefined;
  if (inlineUser !== null && inlineUser.length > 0) {
    const cleaned = cleanCredential(inlineUser, false);
    if (cleaned === null) {
      if (options.strictCredentials) return fail('invalid_credentials', 'invalid username');
      return fail('invalid_credentials', 'invalid username');
    }
    username = cleaned;
  }
  if (inlinePass !== null && inlinePass.length > 0) {
    const cleaned = cleanCredential(inlinePass, false);
    if (cleaned === null) return fail('invalid_credentials', 'invalid password');
    password = cleaned;
  }
  if (password !== undefined && username === undefined) {
    return fail('invalid_credentials', 'password without username');
  }

  if (protocol === null) {
    const hint = options.protocolHint;
    if (hint && isProxyProtocol(hint)) {
      protocol = hint;
      protocol_source = 'hint';
    } else {
      protocol =
        options.defaultProtocol && isProxyProtocol(options.defaultProtocol)
          ? options.defaultProtocol
          : 'http';
      protocol_source = 'default';
    }
  }

  const proxy: NormalizedProxy = {
    host,
    port,
    protocol,
    username,
    password,
    anonymity: 'unknown',
  };
  if (country !== undefined) proxy.country = country;

  return { ok: true, proxy, protocol_source };
}

/** Stable identity of a proxy: same endpoint + same protocol + same account == the same proxy. */
export function dedupeKey(
  proxy: Pick<ProxyEndpoint, 'host' | 'port' | 'protocol'> & { username?: string | null },
): string {
  return `${proxy.protocol}|${proxy.host.toLowerCase()}|${proxy.port}|${(proxy.username ?? '').toLowerCase()}`;
}

/** Short non-reversible key used for the unique DB index (never stores credentials). */
export function dedupeKeyHash(
  proxy: Pick<ProxyEndpoint, 'host' | 'port' | 'protocol'> & { username?: string | null },
): string {
  const key = dedupeKey(proxy);
  // FNV-1a 64bit, hex encoded. Collisions are astronomically unlikely at pool sizes and a
  // collision only means "already known", which is a safe outcome.
  let h1 = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < key.length; i++) {
    h1 ^= BigInt(key.charCodeAt(i));
    h1 = (h1 * prime) & mask;
  }
  return h1.toString(16).padStart(16, '0');
}

/** Credential-free representation, safe for logs and API responses. */
export function formatProxyRedacted(
  endpoint: Pick<ProxyEndpoint, 'host' | 'port' | 'protocol'> & { username?: string | null },
): string {
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host;
  const auth = endpoint.username ? '***:***@' : '';
  return `${endpoint.protocol}://${auth}${host}:${endpoint.port}`;
}

/** Compact one-line description for logs. Guarantees no secret material. */
export function describeProxy(endpoint: ProxyEndpoint): string {
  return formatProxyRedacted(endpoint);
}

/** Builds the dial coordinates for a DB row. Credentials stay inside the process. */
export function endpointFromRecord(record: ProxyRecordLike): ProxyEndpoint {
  const endpoint: ProxyEndpoint = {
    host: record.host,
    port: record.port,
    protocol: record.protocol,
  };
  if (record.username) endpoint.username = record.username;
  if (record.password) endpoint.password = record.password;
  return endpoint;
}

/** Anything row-shaped that carries the dial coordinates (null and undefined both mean "absent"). */
export interface ProxyRecordLike {
  host: string;
  port: number;
  protocol: ProxyProtocol;
  username?: string | null;
  password?: string | null;
}

export interface ParseListResult {
  proxies: NormalizedProxy[];
  /** Index-aligned rejection reasons for the lines that could not be parsed. */
  rejected: { line: string; reason: ParseFailureReason }[];
  /** Number of duplicates removed within this batch. */
  duplicates: number;
  total_lines: number;
  skipped_lines: number;
}

/**
 * Parses a whole text blob (one entry per line). Duplicate keys inside the batch are dropped,
 * lines starting with `#` or `//` are treated as comments and protocol-only lines update the
 * active protocol hint (so "SOCKS5" sections are honored).
 */
export function parseProxyList(
  text: string,
  options: ParseOptions & { maxEntries?: number } = {},
): ParseListResult {
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
  const lines = text.split(/\r?\n/);
  const proxies: NormalizedProxy[] = [];
  const rejected: { line: string; reason: ParseFailureReason }[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let skippedLines = 0;
  let hint = options.protocolHint ?? null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#') || line.startsWith('//') || line.startsWith(';')) {
      skippedLines++;
      continue;
    }
    if (line.length > MAX_ENTRY_LENGTH) {
      rejected.push({ line: line.slice(0, 48), reason: 'too_long' });
      continue;
    }
    if (looksLikeMarkup(line)) {
      rejected.push({ line: line.slice(0, 48), reason: 'not_an_entry' });
      continue;
    }
    // Header/label noise: prose, section markers and bare protocol names. Anything that could plausibly
    // be an endpoint (`host:port`, `1.2.3`) is parsed so it is reported as malformed instead of ignored.
    if (!line.includes(':')) {
      const detected = detectProtocolFromLabel(line);
      if (detected) {
        hint = detected;
        skippedLines++;
        continue;
      }
      const bareHost = !/\s/.test(line) && /\d/.test(line);
      if (!bareHost) {
        skippedLines++;
        continue;
      }
    }

    const parsed = parseProxyEntry(line, {
      ...options,
      protocolHint: hint ?? options.protocolHint,
    });
    if (!parsed.ok) {
      rejected.push({ line: line.slice(0, 48), reason: parsed.reason });
      continue;
    }
    const key = dedupeKey(parsed.proxy);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    proxies.push(parsed.proxy);
    if (proxies.length >= maxEntries) break;
  }

  return {
    proxies,
    rejected,
    duplicates,
    total_lines: lines.length,
    skipped_lines: skippedLines,
  };
}
