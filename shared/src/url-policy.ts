/**
 * URL policy for anything ProxyPulse fetches by itself (proxy source lists, robots.txt, the
 * configured validation/service endpoints). This is the first SSRF gate; DNS-rebound addresses are
 * caught by the worker's resolver-aware lookup.
 */

import { inspectAddress, isMetadataHostname } from './ip.js';

export const MAX_URL_LENGTH = 2_048;

export interface UrlPolicy {
  allowedProtocols?: readonly string[];
  /** Dev/test escape hatch so local mock servers can act as sources/targets. */
  allowPrivate?: boolean;
  blockMetadata?: boolean;
  allowedPorts?: readonly number[];
  maxUrlLength?: number;
}

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

const DEFAULT_PROTOCOLS = ['http:', 'https:'] as const;

/** Validated, normalized URL or a machine readable reason. Never throws. */
export function checkUrlPolicy(raw: string, policy: UrlPolicy = {}): UrlVerdict {
  const maxLen = policy.maxUrlLength ?? MAX_URL_LENGTH;
  const value = (raw ?? '').trim();
  if (value.length === 0) return { ok: false, reason: 'empty url' };
  if (value.length > maxLen) return { ok: false, reason: `url longer than ${maxLen} characters` };
  if (/[\s\p{Cc}]/u.test(value))
    return { ok: false, reason: 'url contains whitespace or control characters' };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'url is not absolute or is malformed' };
  }

  const allowedProtocols = policy.allowedProtocols ?? DEFAULT_PROTOCOLS;
  if (!allowedProtocols.includes(url.protocol)) {
    return { ok: false, reason: `protocol "${url.protocol}" is not allowed` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials in URL are not allowed' };
  }
  if (url.hostname.length === 0) return { ok: false, reason: 'missing hostname' };

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // `localhost` resolves through nss/files on every OS, so it is blocked without waiting for DNS.
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'the localhost name space is not allowed' };
  }
  if (policy.blockMetadata !== false && isMetadataHostname(host)) {
    return { ok: false, reason: 'cloud metadata endpoints are not allowed' };
  }

  const verdict = inspectAddress(host);
  if (verdict.kind !== 'hostname' && verdict.blocked) {
    if (!(policy.allowPrivate && verdict.classification !== 'cloud_metadata')) {
      return { ok: false, reason: `${verdict.classification} address (${host}) is not allowed` };
    }
  }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, reason: 'invalid port' };
  }
  if (
    policy.allowedPorts &&
    policy.allowedPorts.length > 0 &&
    !policy.allowedPorts.includes(port)
  ) {
    return { ok: false, reason: `port ${port} is not in the allowed port list` };
  }
  if (port === 25) return { ok: false, reason: 'SMTP port 25 is not allowed' };

  return { ok: true, url };
}

/** True when the host part is a literal IP; the caller must still resolve hostnames. */
export function hostIsLiteralIp(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  const verdict = inspectAddress(host);
  return verdict.kind !== 'hostname';
}

export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
