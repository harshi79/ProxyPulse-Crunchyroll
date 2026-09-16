/**
 * SSRF-safe address resolution + connect helpers.
 *
 * Two layers of defence:
 *   1. policy check of literal hosts before any socket is opened;
 *   2. DNS resolution followed by a policy check of *every* returned record, and the resolved IP is
 *      what we actually connect to (so a record cannot be flipped to 127.0.0.1 between check and use).
 */

import { promises as dnsPromises } from 'node:dns';
import type { LookupFunction } from 'node:net';

import {
  inspectAddress,
  isMetadataHostname,
  isProxyEndpointAllowed,
  type AddressClassification,
} from '@proxypulse/shared';

export class SsrfBlockedError extends Error {
  readonly code = 'blocked_by_policy';
  constructor(
    readonly host: string,
    readonly reason: string,
    readonly classification: AddressClassification = 'private',
  ) {
    super(`blocked by network policy: ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

export interface SafeResolveOptions {
  allowPrivate: boolean;
  cacheTtlMs?: number;
  /** Injectable for tests; defaults to `node:dns/promises`. */
  resolver?: {
    resolve4: (host: string) => Promise<string[]>;
    resolve6: (host: string) => Promise<string[]>;
  };
}

interface CacheEntry {
  address: string;
  family: 4 | 6;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

export function clearAddressCache(): void {
  cache.clear();
}

/** Resolves a host to a single address that passed the policy. Throws SsrfBlockedError otherwise. */
export async function safeResolve(
  host: string,
  options: SafeResolveOptions,
): Promise<{ address: string; family: 4 | 6 }> {
  const literal = host.replace(/^\[|\]$/g, '');
  if (isMetadataHostname(literal)) {
    throw new SsrfBlockedError(host, 'cloud metadata hostname is not allowed', 'cloud_metadata');
  }
  const direct = isProxyEndpointAllowed(literal, { allowPrivate: options.allowPrivate });
  const verdict = inspectAddress(literal);
  if (verdict.kind !== 'hostname') {
    if (!direct.ok) throw new SsrfBlockedError(host, direct.reason, verdict.classification);
    return { address: literal, family: verdict.kind === 'ipv6' ? 6 : 4 };
  }

  const key = `${options.allowPrivate ? 'p' : 'x'}:${literal.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return { address: hit.address, family: hit.family };

  const resolver = options.resolver ?? dnsPromises;
  const records: string[] = [];
  let lastError: unknown = null;
  for (const family of [4, 6] as const) {
    try {
      const addresses =
        family === 4 ? await resolver.resolve4(literal) : await resolver.resolve6(literal);
      records.push(...addresses);
    } catch (error) {
      lastError = error;
    }
  }
  if (records.length === 0) {
    const message = lastError instanceof Error ? lastError.message : 'no DNS records';
    const error = new Error(`DNS resolution failed for ${literal}: ${message}`) as Error & {
      code: string;
    };
    error.code = 'ENOTFOUND';
    throw error;
  }

  const metadataHit = records.some(
    (address) => inspectAddress(address).classification === 'cloud_metadata',
  );
  if (metadataHit && !options.allowPrivate) {
    throw new SsrfBlockedError(host, 'host resolves to a cloud metadata address', 'cloud_metadata');
  }
  for (const address of records) {
    const check = isProxyEndpointAllowed(address, { allowPrivate: options.allowPrivate });
    if (check.ok) {
      const inspected = inspectAddress(address);
      const entry = {
        address,
        family: (inspected.kind === 'ipv6' ? 6 : 4) as 4 | 6,
        expires: Date.now() + (options.cacheTtlMs ?? 60_000),
      };
      if ((options.cacheTtlMs ?? 60_000) > 0) cache.set(key, entry);
      return { address: entry.address, family: entry.family };
    }
  }
  throw new SsrfBlockedError(
    host,
    `every resolved address is blocked (${records.length} records checked)`,
    'private',
  );
}

/** `net.connect({ lookup })` implementation that pins the policy-checked address. */
export function createSafeLookup(options: SafeResolveOptions): LookupFunction {
  return (hostname, _lookupOptions, callback) => {
    safeResolve(hostname, options).then(
      ({ address, family }) => callback(null, address, family),
      (error: unknown) =>
        callback(
          (error instanceof Error ? error : new Error(String(error))) as NodeJS.ErrnoException,
          '',
          4,
        ),
    );
  };
}
