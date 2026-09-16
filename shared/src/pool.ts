/**
 * Pool selection helpers, shared by the worker (which owns the pool) and the Cloudflare API
 * (which may pick a subset out of a cached /pool response).
 */

import { type PublicProxy } from './types.js';

export const DEFAULT_MAX_POOL_PAGE = 500;
export const HARD_MAX_POOL_PAGE = 5_000;

export interface PoolQuery {
  limit: number;
  offset: number;
  protocol: string | null;
  minScore: number;
  maxLatencyMs: number | null;
  country: string | null;
  service: 'required' | 'preferred' | 'off';
}

export interface ParsedPoolQuery {
  query: PoolQuery;
  warnings: string[];
  error: string | null;
}

const clampInt = (raw: string | null, fallback: number, min: number, max: number): number => {
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

/** Parses and bounds the public `GET /pool` and `GET /random` query string. */
export function parsePoolQuery(params: URLSearchParams): ParsedPoolQuery {
  const warnings: string[] = [];
  const requestedLimit = params.get('limit');
  let limit = clampInt(requestedLimit, 50, 1, HARD_MAX_POOL_PAGE);
  if (requestedLimit !== null && limit > DEFAULT_MAX_POOL_PAGE) {
    limit = DEFAULT_MAX_POOL_PAGE;
    warnings.push(`limit clamped to ${DEFAULT_MAX_POOL_PAGE}`);
  }
  const protocol = params.get('protocol');
  if (protocol !== null && !['http', 'https', 'socks4', 'socks5'].includes(protocol)) {
    return {
      query: {
        limit,
        offset: 0,
        protocol: null,
        minScore: 0,
        maxLatencyMs: null,
        country: null,
        service: 'required',
      },
      warnings,
      error: `invalid protocol "${protocol}" (expected http, https, socks4 or socks5)`,
    };
  }
  const country = params.get('country');
  if (country !== null && country.length > 0 && !/^[a-z]{2}$/i.test(country)) {
    return {
      query: {
        limit,
        offset: 0,
        protocol: null,
        minScore: 0,
        maxLatencyMs: null,
        country: null,
        service: 'required',
      },
      warnings,
      error: 'invalid country (expected a two letter ISO code)',
    };
  }
  const service = params.get('service') ?? 'required';
  if (!['required', 'preferred', 'off'].includes(service)) {
    return {
      query: {
        limit,
        offset: 0,
        protocol: null,
        minScore: 0,
        maxLatencyMs: null,
        country: null,
        service: 'required',
      },
      warnings,
      error: 'invalid service filter (expected required, preferred or off)',
    };
  }
  return {
    query: {
      limit,
      offset: clampInt(params.get('offset'), 0, 0, 100_000),
      protocol: protocol && protocol.length > 0 ? protocol : null,
      minScore: clampInt(params.get('min_score'), 0, 0, 100),
      maxLatencyMs: params.get('max_latency_ms')
        ? clampInt(params.get('max_latency_ms'), 0, 0, 600_000)
        : null,
      country: country ? country.toUpperCase() : null,
      service: service as PoolQuery['service'],
    },
    warnings,
    error: null,
  };
}

export function sortByScore(entries: readonly PublicProxy[]): PublicProxy[] {
  return [...entries].sort(
    (a, b) => b.score - a.score || a.latency_ms! - b.latency_ms! || a.id - b.id,
  );
}

/** Deterministic weighted pick: higher score = higher chance. `rng` makes it testable. */
export function weightedRandomPick<T extends { score: number }>(
  entries: readonly T[],
  rng: () => number = Math.random,
): T | null {
  if (entries.length === 0) return null;
  const weights = entries.map((entry) => Math.max(1, entry.score));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let target = rng() * total;
  for (let index = 0; index < entries.length; index++) {
    target -= weights[index]!;
    if (target <= 0) return entries[index]!;
  }
  return entries[entries.length - 1]!;
}

export function protocolBreakdown(
  entries: readonly { protocol: string }[],
): Record<string, number> {
  const out: Record<string, number> = { http: 0, https: 0, socks4: 0, socks5: 0 };
  for (const entry of entries) {
    out[entry.protocol] = (out[entry.protocol] ?? 0) + 1;
  }
  return out;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round(total / values.length);
}
