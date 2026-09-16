/**
 * Worker bindings and their normalised form. Everything is optional-by-default so the gateway boots
 * for local development (`wrangler dev`) and only hard-fails in production when a required secret is
 * missing — that way a typo never turns the public API into a 500 machine.
 */

export const GATEWAY_ENDPOINTS = [
  '/pool',
  '/random',
  '/stats',
  '/tpool',
  '/health',
  '/healthz',
] as const;
export type GatewayEndpoint = (typeof GATEWAY_ENDPOINTS)[number];

/** Public path -> worker internal path. `/healthz` and `/` never leave the edge. */
export const UPSTREAM_PATHS: Record<GatewayEndpoint, string | null> = {
  '/pool': '/internal/pool',
  '/random': '/internal/random',
  '/stats': '/internal/stats',
  '/tpool': '/internal/tpool',
  '/health': '/health',
  '/healthz': null,
};

export interface KvStore {
  get(key: string, options?: { type?: 'text' }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface Env {
  /** Origin of the Render worker, e.g. `https://proxypulse-worker.onrender.com`. */
  RENDER_ORIGIN?: string;
  /** Bearer token the worker's internal API expects (`INTERNAL_API_TOKEN` on the worker). */
  INTERNAL_API_TOKEN?: string;
  /** Comma separated list of public reader keys. Empty means the API is open (non-production only). */
  API_PUBLIC_KEYS?: string;
  /** KV namespace used for the fixed-window rate limiter. Optional: the limiter fails open. */
  RATE_LIMIT_KV?: KvStore;
  RATE_LIMIT_MAX?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  CACHE_ENABLED?: string;
  UPSTREAM_TIMEOUT_MS?: string;
  /** `keepalive` (default): the cron trigger only pokes /health so a sleeping origin stays reachable. */
  CYCLE_TRIGGER_ENABLED?: string;
  /** `keepalive` | `trigger` — `trigger` POSTs /internal/cycle/run instead, driving the cadence. */
  CYCLE_TRIGGER_MODE?: string;
  ENVIRONMENT?: string;
  LOG_LEVEL?: string;
}

export interface GatewayConfig {
  renderOrigin: string;
  internalToken: string;
  publicKeys: string[];
  requireAuth: boolean;
  production: boolean;
  rateLimit: { max: number; windowSeconds: number };
  cacheEnabled: boolean;
  upstreamTimeoutMs: number;
  /** What the optional Cron Trigger does; only meaningful when `triggers.crons` is deployed. */
  cronTrigger: { enabled: boolean; mode: 'keepalive' | 'trigger' };
}

const trimSlash = (value: string): string => value.replace(/\/{1,}$/, '');

/** Throws a human readable error the handler turns into a 503 rather than guessing at defaults. */
export function readConfig(env: Env): GatewayConfig {
  const production = env.ENVIRONMENT === 'production';
  const origin = (env.RENDER_ORIGIN ?? '').trim();
  if (origin.length === 0) throw new ConfigIssue('RENDER_ORIGIN is not configured');
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ConfigIssue('RENDER_ORIGIN is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && !(production === false && parsed.protocol === 'http:')) {
    throw new ConfigIssue('RENDER_ORIGIN must be an https:// URL in production');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new ConfigIssue('RENDER_ORIGIN must be an origin without a path');
  }
  const internalToken = (env.INTERNAL_API_TOKEN ?? '').trim();
  if (internalToken.length < 16)
    throw new ConfigIssue('INTERNAL_API_TOKEN must be at least 16 characters');

  const publicKeys = (env.API_PUBLIC_KEYS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length >= 8);

  return {
    renderOrigin: trimSlash(parsed.toString()),
    internalToken,
    publicKeys,
    requireAuth: publicKeys.length > 0 || production,
    production,
    rateLimit: {
      max: readInt(env.RATE_LIMIT_MAX, 120, 1, 100_000),
      windowSeconds: readInt(env.RATE_LIMIT_WINDOW_SECONDS, 60, 1, 3_600),
    },
    cacheEnabled: (env.CACHE_ENABLED ?? '1') !== '0',
    upstreamTimeoutMs: readInt(env.UPSTREAM_TIMEOUT_MS, 10_000, 500, 60_000),
    cronTrigger: {
      enabled: (env.CYCLE_TRIGGER_ENABLED ?? '1') !== '0',
      mode: env.CYCLE_TRIGGER_MODE === 'trigger' ? 'trigger' : 'keepalive',
    },
  };
}

export class ConfigIssue extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigIssue';
  }
}

function readInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
