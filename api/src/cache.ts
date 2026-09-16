/**
 * Edge response cache.
 *
 * Only the read-only, pool-shaped endpoints are cached, with the per-endpoint TTL from the shared API
 * contract. Bodies are buffered (they are small and capped by `limit`) so the gateway can inject
 * `meta.cached` / `meta.stale` into the JSON envelope. A stale entry is served when the upstream fails,
 * which keeps the public API readable even while a cycle is running or the origin is briefly down.
 * Cache keys never include credentials.
 */

import { DEFAULT_CACHE_TTL_SECONDS, type ApiEndpoint } from '@proxypulse/shared';

export interface ResponseCache {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
}

/** Endpoints worth caching. `/random` is excluded on purpose: it must not repeat itself. */
export const CACHEABLE: readonly ApiEndpoint[] = ['/pool', '/stats', '/tpool'];

export const CACHED_AT_HEADER = 'x-proxypulse-cached-at';
export const AGE_HEADER = 'age';

export function isCacheable(endpoint: string): endpoint is ApiEndpoint {
  return (CACHEABLE as readonly string[]).includes(endpoint);
}

export function ttlFor(endpoint: ApiEndpoint): number {
  return DEFAULT_CACHE_TTL_SECONDS[endpoint] ?? 0;
}

/** Cache key: pathname + normalised (sorted) query, minus cache-busting parameters. */
export function cacheKey(url: URL, namespace = 'pp'): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete('bypass_cache');
  params.delete('_');
  const sorted = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(sorted).toString();
  return `${namespace}:${url.pathname}${query.length > 0 ? `?${query}` : ''}`;
}

export interface CacheLookup {
  hit: boolean;
  stale: boolean;
  ageSeconds: number;
  status: number;
  body: string | null;
}

const MISS: CacheLookup = { hit: false, stale: false, ageSeconds: 0, status: 0, body: null };

export async function lookupCache(
  cache: ResponseCache | null,
  key: string,
  ttlSeconds: number,
  nowMs = Date.now(),
): Promise<CacheLookup> {
  if (!cache || ttlSeconds <= 0) return MISS;
  try {
    const found = await cache.match(key);
    if (!found) return MISS;
    const body = await found.text();
    const cachedAt = Number(found.headers.get(CACHED_AT_HEADER) ?? '0');
    const ageSeconds = cachedAt > 0 ? Math.max(0, Math.floor(nowMs / 1000) - cachedAt) : 0;
    return {
      hit: true,
      stale: ageSeconds > ttlSeconds,
      ageSeconds,
      status: found.status,
      body,
    };
  } catch {
    return MISS;
  }
}

/** Stores a 200 JSON body. Failures are swallowed: the cache is an optimisation, never a dependency. */
export async function writeCache(
  cache: ResponseCache | null,
  key: string,
  body: string,
  ttlSeconds: number,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!cache || ttlSeconds <= 0 || body.length === 0) return false;
  try {
    await cache.put(
      key,
      new Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          [CACHED_AT_HEADER]: String(Math.floor(nowMs / 1000)),
          'cache-control': `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
        },
      }),
    );
    return true;
  } catch {
    return false;
  }
}
