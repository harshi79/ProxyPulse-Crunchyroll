/**
 * Fixed-window rate limiting on the KV namespace.
 *
 * Deliberately soft: a missed counter under a KV outage fails open rather than returning 500s to
 * paying traffic. The window is `floor(now / windowSeconds)` so every edge counts the same bucket.
 */

import type { KvStore } from './env';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds: number;
}

export interface RateLimitDeps {
  kv?: KvStore | undefined;
  max: number;
  windowSeconds: number;
  now?: () => number;
}

export const ALLOWED: RateLimitResult = {
  allowed: true,
  limit: 0,
  remaining: 0,
  resetSeconds: 0,
  retryAfterSeconds: 0,
};

export function limitKey(bucket: string, address: string, window: number): string {
  return `rl:${bucket}:${address}:${window}`;
}

export async function checkRateLimit(
  deps: RateLimitDeps,
  bucket: string,
  address: string,
): Promise<RateLimitResult> {
  const nowMs = deps.now?.() ?? Date.now();
  const windowSeconds = Math.max(1, deps.windowSeconds);
  const window = Math.floor(nowMs / 1_000 / windowSeconds);
  const resetSeconds = windowSeconds - (Math.floor(nowMs / 1_000) % windowSeconds);
  const base: RateLimitResult = {
    allowed: true,
    limit: deps.max,
    remaining: deps.max,
    resetSeconds,
    retryAfterSeconds: 0,
  };
  if (!deps.kv) return { ...base, limit: 0, remaining: 0 };

  const key = limitKey(bucket, address, window);
  try {
    const raw = await deps.kv.get(key);
    const count = Number(raw ?? '0');
    const next = (Number.isFinite(count) ? count : 0) + 1;
    await deps.kv.put(key, String(next), { expirationTtl: windowSeconds + 1 });
    if (next > deps.max) {
      return {
        allowed: false,
        limit: deps.max,
        remaining: 0,
        resetSeconds,
        retryAfterSeconds: resetSeconds,
      };
    }
    return { ...base, remaining: Math.max(0, deps.max - next) };
  } catch {
    // A KV failure must never take the API down.
    return base;
  }
}
