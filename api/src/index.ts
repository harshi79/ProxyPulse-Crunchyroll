/**
 * ProxyPulse public API gateway (Cloudflare Worker).
 *
 *   GET /pool      paged, filtered view of the healthy proxy pool
 *   GET /random    one score-weighted proxy
 *   GET /stats     pool statistics + the latest cycle
 *   GET /tpool     {service, valid, last_check, next_check} summary of the latest test cycle
 *   GET /health    upstream liveness, proxied
 *   GET /healthz   the edge itself (no upstream call, no auth)
 *
 * The gateway owns the public contract (envelope, request ids, caching, rate limiting, auth) and
 * forwards to the Render worker's internal API. It never returns proxy credentials, never trusts a
 * client-supplied upstream address, and serves a stale cache entry instead of failing when the origin
 * is briefly unavailable.
 */

import {
  API_ERROR_CODES,
  buildMeta,
  DEFAULT_CACHE_TTL_SECONDS,
  envelope,
  failureBody,
  HTTP_STATUS_FOR_ERROR,
  newRequestId,
  parsePoolQuery,
  API_ENDPOINTS,
  type ApiEndpoint,
  type ApiErrorCode,
} from '@proxypulse/shared';

import { ConfigIssue, readConfig, UPSTREAM_PATHS, type Env, type GatewayConfig } from './env';
import { ANONYMOUS_BUCKET, authenticate, clientAddress } from './auth';
import { checkRateLimit, type RateLimitResult } from './rate-limit';
import {
  cacheKey,
  isCacheable,
  lookupCache,
  ttlFor,
  writeCache,
  type ResponseCache,
} from './cache';
import { callUpstream } from './upstream';

export interface GatewayEnv extends Env {
  /** Injected by tests; the runtime provides `caches.default`. */
  __cache?: ResponseCache;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface CronEvent {
  readonly cron: string;
  readonly scheduledTime: number;
  noRetry(): void;
}

/** What the cron trigger calls on the origin, per mode. */
const CRON_TARGETS: Record<'keepalive' | 'trigger', { path: string; method: 'GET' | 'POST' }> = {
  // `/health` is unauthenticated and cheap: it exists to keep a sleeping origin awake, and the worker's
  // own scheduler keeps the real refresh cadence.
  keepalive: { path: '/health', method: 'GET' },
  // `trigger` lets the edge drive cycles (useful if the worker's scheduler is switched off). A cycle is
  // single-flight, so an extra poke is answered 409 and costs nothing.
  trigger: { path: '/internal/cycle/run', method: 'POST' },
};

const VERSION = '0.1.0';

const ENDPOINT_DOCS: Record<ApiEndpoint, string> = {
  '/pool':
    'paged, filtered list of validated proxies (limit, offset, protocol, min_score, max_latency_ms, country, service)',
  '/random': 'one score-weighted proxy; accepts the same filters as /pool and is never cached',
  '/stats': 'pool statistics, latest completed cycle and worker status',
  '/tpool': 'service compatibility summary: {service, valid, last_check, next_check}',
  '/health': 'liveness of the pool origin',
};

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'authorization, x-api-key, x-request-id',
  'access-control-max-age': '600',
};

const json = (
  body: string,
  init: { status?: number; headers?: Record<string, string> },
): Response =>
  new Response(body, {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });

function normalizePath(pathname: string): string {
  const clean = pathname.replace(/\/{2,}/g, '/');
  return clean.length > 1 ? clean.replace(/\/$/, '') : clean;
}

function publicError(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  extra: Record<string, string> = {},
): Response {
  return json(JSON.stringify(failureBody(code, message, requestId)), {
    status: HTTP_STATUS_FOR_ERROR[code],
    headers: { 'x-request-id': requestId, ...extra },
  });
}

function rateHeaders(limit: RateLimitResult): Record<string, string> {
  if (limit.limit <= 0) return {};
  return {
    'ratelimit-limit': String(limit.limit),
    'ratelimit-remaining': String(limit.remaining),
    'ratelimit-reset': String(limit.resetSeconds),
  };
}

export default {
  async fetch(request: Request, env: GatewayEnv, ctx?: ExecutionContext): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const inbound = request.headers.get('x-request-id') ?? '';
    const requestId = /^[A-Za-z0-9._:-]{1,64}$/.test(inbound) ? inbound : newRequestId('req');
    const path = normalizePath(url.pathname);

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS_HEADERS });

    let config: GatewayConfig;
    try {
      config = readConfig(env);
    } catch (error) {
      const message = error instanceof ConfigIssue ? error.message : 'gateway is misconfigured';
      // /healthz still answers so an operator can see *why* the edge is unhappy.
      if (path === '/healthz') {
        return json(
          JSON.stringify({
            ok: false,
            error: { code: 'unavailable', message },
            meta: { request_id: requestId, timestamp: new Date().toISOString() },
          }),
          { status: 503 },
        );
      }
      return publicError('unavailable', message, requestId);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return publicError('bad_request', 'only GET is supported', requestId, {
        allow: 'GET, OPTIONS',
      });
    }

    if (path === '/healthz' || path === '/') {
      return json(
        JSON.stringify(
          envelope(
            {
              service: 'proxypulse',
              edge: 'cloudflare-worker',
              version: VERSION,
              status: 'ok',
              endpoints: API_ENDPOINTS.filter((endpoint) => endpoint !== '/health'),
              documentation: ENDPOINT_DOCS,
              rate_limit: config.rateLimit,
              cache: config.cacheEnabled ? DEFAULT_CACHE_TTL_SECONDS : 'disabled',
              upstream: 'configured',
              latency_ms: Date.now() - started,
            },
            buildMeta({ request_id: requestId, service: 'proxypulse' }),
          ),
        ),
        {
          headers: {
            'cache-control': 'no-store',
            ...rateHeaders({
              allowed: true,
              limit: 0,
              remaining: 0,
              resetSeconds: 0,
              retryAfterSeconds: 0,
            }),
          },
        },
      );
    }

    if (!(API_ENDPOINTS as readonly string[]).includes(path)) {
      return publicError(
        'not_found',
        `unknown endpoint "${path}" (try ${API_ENDPOINTS.join(', ')})`,
        requestId,
      );
    }
    const endpoint = path as ApiEndpoint;

    const isProbe = endpoint === '/health';
    const auth = isProbe
      ? { ok: true as const, bucket: ANONYMOUS_BUCKET }
      : authenticate(request, { keys: config.publicKeys, required: config.requireAuth });
    if (!auth.ok) {
      return publicError(
        auth.error?.code ?? 'unauthorized',
        auth.error?.message ?? 'unauthorized',
        requestId,
        {
          'www-authenticate': 'Bearer realm="proxypulse"',
        },
      );
    }

    const limit = await checkRateLimit(
      {
        kv: env.RATE_LIMIT_KV,
        max: config.rateLimit.max,
        windowSeconds: config.rateLimit.windowSeconds,
      },
      auth.bucket === ANONYMOUS_BUCKET ? `ip:${clientAddress(request)}` : auth.bucket,
      clientAddress(request),
    );
    if (!limit.allowed) {
      return publicError(
        'rate_limited',
        `rate limit of ${limit.limit} requests per ${config.rateLimit.windowSeconds}s exceeded`,
        requestId,
        {
          'retry-after': String(limit.retryAfterSeconds),
          ...rateHeaders(limit),
        },
      );
    }

    // Query validation happens at the edge so a bad filter never reaches the origin.
    if (endpoint === '/pool' || endpoint === '/random') {
      const parsed = parsePoolQuery(url.searchParams);
      if (parsed.error)
        return publicError('bad_request', parsed.error, requestId, rateHeaders(limit));
    }

    const cache: ResponseCache | null = env.__cache ?? resolveGlobalCache(env);
    const ttl = config.cacheEnabled && isCacheable(endpoint) ? ttlFor(endpoint) : 0;
    const key = cacheKey(url, `pp:${endpoint}`);
    const bypass = config.production === false && url.searchParams.get('bypass_cache') === '1';

    if (ttl > 0 && !bypass) {
      const hit = await lookupCache(cache, key, ttl);
      if (hit.hit && !hit.stale && hit.body !== null) {
        return respondWithMeta(hit.body, endpoint, requestId, limit, {
          cached: true,
          stale: false,
          ageSeconds: hit.ageSeconds,
          ttl,
          status: hit.status,
        });
      }
    }

    const upstreamPath = UPSTREAM_PATHS[endpoint];
    if (upstreamPath === null)
      return publicError(
        'not_found',
        'no upstream for this endpoint',
        requestId,
        rateHeaders(limit),
      );
    const upstream = await callUpstream({
      path: upstreamPath,
      search: url.searchParams.toString(),
      config,
      requestId,
    });

    if (!upstream.ok) {
      // Stale-on-error: a slightly old pool is far more useful than an outage.
      if (ttl > 0) {
        const stale = await lookupCache(cache, key, ttl);
        if (stale.hit && stale.body !== null) {
          return respondWithMeta(stale.body, endpoint, requestId, limit, {
            cached: true,
            stale: true,
            ageSeconds: stale.ageSeconds,
            ttl,
            status: 200,
          });
        }
      }
      return publicError(upstream.code, upstream.message, requestId, {
        ...rateHeaders(limit),
        ...(upstream.status >= 500 ? { 'retry-after': '30' } : {}),
      });
    }

    if (!upstream.contentType.includes('json')) {
      return publicError(
        'upstream_error',
        'the pool origin returned a non-JSON response',
        requestId,
        rateHeaders(limit),
      );
    }

    if (ttl > 0 && upstream.status === 200) {
      const persist = writeCache(cache, key, upstream.body, ttl).catch(() => undefined);
      if (ctx) ctx.waitUntil(persist);
      else await persist;
    }
    return respondWithMeta(upstream.body, endpoint, requestId, limit, {
      cached: false,
      stale: false,
      ageSeconds: 0,
      ttl,
      status: upstream.status,
    });
  },

  /**
   * Optional Cron Trigger (see `triggers` in wrangler.jsonc). Two jobs: keep a sleeping free-tier origin
   * warm, and — in `trigger` mode — ask it to run a refresh cycle. It never surfaces data, so it cannot
   * become a way around the public auth, and every failure is a tail log line rather than a retry storm.
   */
  async scheduled(event: CronEvent, env: GatewayEnv, _ctx: ExecutionContext): Promise<void> {
    let config: GatewayConfig;
    try {
      config = readConfig(env);
    } catch (error) {
      console.warn('proxypulse cron skipped: gateway is misconfigured', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      return;
    }
    if (!config.cronTrigger.enabled) return;

    const target = CRON_TARGETS[config.cronTrigger.mode];
    const requestId = newRequestId('cron');
    try {
      const response = await fetch(`${config.renderOrigin}${target.path}`, {
        method: target.method,
        ...(target.method === 'POST'
          ? {
              headers: {
                authorization: `Bearer ${config.internalToken}`,
                'content-type': 'application/json',
                'x-request-id': requestId,
              },
              body: '{}',
            }
          : { headers: { 'x-request-id': requestId } }),
        signal: AbortSignal.timeout(
          config.cronTrigger.mode === 'trigger'
            ? Math.min(60_000, Math.max(5_000, config.upstreamTimeoutMs))
            : 5_000,
        ),
      });
      if (!response.ok && response.status !== 409) {
        console.warn('proxypulse cron call was not accepted', {
          request_id: requestId,
          mode: config.cronTrigger.mode,
          status: response.status,
          cron: event.cron,
        });
      }
      await response.body?.cancel();
    } catch (error) {
      console.warn('proxypulse cron call failed', {
        request_id: requestId,
        mode: config.cronTrigger.mode,
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  },
};

/** The Workers cache is only reachable through the global, and only inside the runtime. */
function resolveGlobalCache(env: GatewayEnv): ResponseCache | null {
  const globalCaches =
    (env as { caches?: { default?: ResponseCache } }).caches ??
    (globalThis as { caches?: { default?: ResponseCache } }).caches;
  return globalCaches?.default ?? null;
}

interface RespondOptions {
  cached: boolean;
  stale: boolean;
  ageSeconds: number;
  ttl: number;
  status: number;
}

/**
 * Re-signs the upstream envelope with this request's id/timestamp and the gateway's cache state, so a
 * cached body never leaks another caller's request id.
 */
function respondWithMeta(
  body: string,
  endpoint: ApiEndpoint,
  requestId: string,
  limit: RateLimitResult,
  options: RespondOptions,
): Response {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return publicError(
      'upstream_error',
      'the pool origin returned malformed JSON',
      requestId,
      rateHeaders(limit),
    );
  }
  const record = (payload ?? {}) as {
    ok?: boolean;
    data?: Record<string, unknown>;
    meta?: Record<string, unknown>;
    error?: { code?: string; message?: string };
  };

  if (record.ok !== true) {
    const presented = String(record.error?.code ?? 'upstream_error');
    const safe: ApiErrorCode = (API_ERROR_CODES as readonly string[]).includes(presented)
      ? (presented as ApiErrorCode)
      : 'upstream_error';
    return publicError(
      safe,
      String(record.error?.message ?? 'the pool origin rejected the request'),
      requestId,
      rateHeaders(limit),
    );
  }

  const data = record.data ?? {};
  const meta = buildMeta({
    request_id: requestId,
    service: String(data.service ?? 'proxypulse'),
    pool_size: typeof data.pool_size === 'number' ? data.pool_size : null,
    last_update:
      typeof data.last_update === 'string'
        ? data.last_update
        : typeof record.meta?.last_update === 'string'
          ? record.meta.last_update
          : null,
    cached: options.cached,
    stale: options.stale,
  });
  const headers: Record<string, string> = {
    ...rateHeaders(limit),
    'cache-control':
      options.ttl > 0
        ? `public, max-age=${options.ttl}, stale-while-revalidate=${Math.max(10, options.ttl)}`
        : 'no-store',
    'x-proxypulse-endpoint': endpoint,
    'x-proxypulse-cached': options.cached ? '1' : '0',
    'x-proxypulse-stale': options.stale ? '1' : '0',
  };
  if (options.cached) headers.age = String(options.ageSeconds);
  return json(JSON.stringify(envelope(data, meta)), {
    status: options.status,
    headers: { 'x-request-id': requestId, ...headers },
  });
}

export const __testables = { normalizePath, respondWithMeta, cacheKey };
