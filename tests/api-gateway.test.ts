/**
 * The Cloudflare gateway: public auth, edge validation, rate limiting, caching (including
 * stale-on-error) and the response envelope. The handler is called directly with fake bindings, and
 * `fetch` is stubbed, so this runs anywhere Node runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelope, buildMeta } from '@proxypulse/shared';
import handler from '../api/src/index';
import { cacheKey, lookupCache, ttlFor, writeCache, type ResponseCache } from '../api/src/cache';
import { constantTimeEqual } from '../api/src/auth';
import type { Env, KvStore } from '../api/src/env';
import { readJson } from './helpers/json';

type FetchHandler = NonNullable<typeof handler.fetch>;
const call = handler.fetch as unknown as FetchHandler;
const scheduled = handler.scheduled as unknown as (
  event: { cron: string; scheduledTime: number; noRetry(): void },
  env: unknown,
  ctx: unknown,
) => Promise<void>;

const cronEvent = {
  cron: '*/5 * * * *',
  scheduledTime: Date.parse('2026-09-14T12:00:00.000Z'),
  noRetry: () => undefined,
};
const runCron = (env: Env = envFor()) =>
  scheduled(cronEvent, env as never, { waitUntil: () => undefined });

const TOKEN = 'unit_test_worker_token_0123456789';
const KEY = 'pp_live_key_alpha';

interface UpstreamCall {
  url: string;
  method?: string;
  body?: unknown;
  headers: Record<string, string>;
}

const memoryCache = (): ResponseCache & { store: Map<string, Response> } => {
  const store = new Map<string, Response>();
  return {
    store,
    async match(request) {
      const key = typeof request === 'string' ? request : request.url;
      const found = store.get(key);
      return found ? await clone(found) : undefined;
    },
    async put(request, response) {
      const key = typeof request === 'string' ? request : response.url || 'x';
      const body = await response.text();
      const headers = new Headers(response.headers);
      store.set(key, new Response(body, { status: response.status, headers }));
    },
  };
};

const clone = async (response: Response): Promise<Response> => {
  const text = await response.clone().text();
  return new Response(text, { status: response.status, headers: response.headers });
};

const memoryKv = (): KvStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      data.set(key, value);
    },
  };
};

let upstream: (url: string, init?: RequestInit) => Promise<Response>;
let calls: UpstreamCall[] = [];

type TestEnv = Env & { __cache?: ResponseCache };

const envFor = (overrides: Partial<TestEnv> = {}): TestEnv => ({
  RENDER_ORIGIN: 'https://worker.internal.test',
  INTERNAL_API_TOKEN: TOKEN,
  API_PUBLIC_KEYS: `${KEY},pp_live_key_beta`,
  ENVIRONMENT: 'production',
  RATE_LIMIT_KV: memoryKv(),
  __cache: memoryCache(),
  ...overrides,
});

const requestTo = (path: string, headers: Record<string, string> = {}, method = 'GET'): Request =>
  new Request(`https://api.proxypulse.test${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...headers },
  });

const poolPayload = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify(
    envelope(
      {
        service: 'crunchyroll',
        pool_size: 2,
        count: 2,
        limit: 50,
        offset: 0,
        last_update: '2026-01-01T00:00:00.000Z',
        proxies: [
          {
            id: 1,
            host: '203.0.113.1',
            port: 8080,
            protocol: 'http',
            score: 88.5,
            latency_ms: 120,
            country: 'US',
            anonymity: 'unknown',
            last_passed: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 2,
            host: '203.0.113.2',
            port: 1080,
            protocol: 'socks5',
            score: 71.25,
            latency_ms: 210,
            country: 'DE',
            anonymity: 'anonymous',
            last_passed: '2026-01-01T00:00:00.000Z',
          },
        ],
        ...overrides,
      },
      buildMeta({
        request_id: 'req_upstream',
        service: 'crunchyroll',
        pool_size: 2,
        last_update: '2026-01-01T00:00:00.000Z',
      }),
    ),
  );

beforeEach(() => {
  calls = [];
  upstream = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body,
      headers: { ...(init?.headers as Record<string, string>) },
    });
    return new Response(poolPayload(), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  vi.stubGlobal('fetch', upstream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `waitUntil` recorder that tests can drain, so cache writes are observable deterministically. */
const makeCtx = () => {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (promise: Promise<unknown>) => void pending.push(Promise.resolve(promise)) },
    flush: async () => {
      await Promise.all(pending);
      pending.length = 0;
    },
  };
};

const handle = async (
  path: string,
  init: { headers?: Record<string, string>; method?: string } = {},
  env: TestEnv = envFor(),
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> =>
  call(
    requestTo(path, init.headers, init.method),
    env as never,
    (ctx ?? { waitUntil: () => undefined }) as never,
  );

describe('edge contract', () => {
  it('returns the pool with gateway metadata and CORS headers', async () => {
    const response = await handle('/pool?limit=2');
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const body = await readJson(response);
    expect(body.ok).toBe(true);
    expect(body.data.pool_size).toBe(2);
    expect(body.data.proxies).toHaveLength(2);
    expect(body.meta.service).toBe('crunchyroll');
    expect(body.meta.pool_size).toBe(2);
    expect(body.meta.request_id).toMatch(/^req_/);
    expect(body.meta.cached).toBe(false);
    expect(response.headers.get('x-request-id')).toBe(body.meta.request_id);
    expect(response.headers.get('cache-control')).toContain('max-age=30');
  });

  it('never forwards the public key upstream and always sends the internal token', async () => {
    await handle('/pool?limit=2&protocol=http');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(calls)).not.toContain(KEY);
    expect(calls[0]?.url).toBe('https://worker.internal.test/internal/pool?limit=2&protocol=http');
  });

  it('answers the index and /healthz without touching the origin', async () => {
    const index = await handle('/');
    const body = await readJson(index);
    expect(body.data.endpoints).toEqual(['/pool', '/random', '/stats', '/tpool']);
    expect(body.data.documentation['/tpool']).toContain('last_check');
    expect(calls).toHaveLength(0);

    const healthz = await handle('/healthz');
    expect(healthz.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('rejects unknown endpoints, non-GET methods and malformed filters at the edge', async () => {
    expect((await handle('/nope')).status).toBe(404);
    const method = await handle('/pool', { method: 'POST' });
    expect(method.status).toBe(400);
    const bad = await handle('/pool?protocol=ftp');
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error.message).toContain('expected http, https, socks4 or socks5');
    // validation happened locally: the origin was never called
    expect(calls).toHaveLength(0);
  });

  it('answers a preflight immediately', async () => {
    const response = await call(
      new Request('https://api.proxypulse.test/pool', { method: 'OPTIONS' }),
      envFor() as never,
      { waitUntil: () => undefined } as never,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toContain('x-api-key');
  });
});

describe('authentication', () => {
  it('requires a key in production and accepts any configured one', async () => {
    const missing = await handle('/pool', { headers: { authorization: '' } });
    expect(missing.status).toBe(401);
    expect((await readJson(missing)).error.code).toBe('unauthorized');

    expect(
      (await handle('/pool', { headers: { authorization: 'Bearer pp_live_key_beta' } })).status,
    ).toBe(200);
    expect((await handle('/pool', { headers: { 'x-api-key': KEY } })).status).toBe(200);
    expect(
      (await handle('/pool', { headers: { authorization: 'Bearer pp_live_wrong' } })).status,
    ).toBe(401);
  });

  it('passes /health through without a key', async () => {
    const response = await call(
      new Request('https://api.proxypulse.test/health'),
      envFor() as never,
      { waitUntil: () => undefined } as never,
    );
    expect(response.status).toBe(200);
  });

  it('refuses to serve when no keys are configured in production', async () => {
    const response = await handle('/pool', {}, envFor({ API_PUBLIC_KEYS: '' }));
    expect(response.status).toBe(403);
  });

  it('fails closed on a broken configuration instead of guessing', async () => {
    const broken = await handle('/pool', {}, envFor({ RENDER_ORIGIN: '' }));
    expect(broken.status).toBe(503);
    expect((await readJson(broken)).error.message).toContain('RENDER_ORIGIN');
    const diagnostic = await handle('/healthz', {}, envFor({ RENDER_ORIGIN: 'not a url' }));
    expect(diagnostic.status).toBe(503);
    expect((await readJson(diagnostic)).error.message).toContain('RENDER_ORIGIN');
    const insecure = await handle(
      '/pool',
      {},
      envFor({ RENDER_ORIGIN: 'https://worker.internal.test/pool' }),
    );
    expect(insecure.status).toBe(503);
  });

  it('compares keys without short-circuiting on length differences', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('pp_live_key_alpha', 'pp_live_key_alpha')).toBe(true);
  });
});

describe('rate limiting', () => {
  it('counts requests per key in a fixed window and returns 429 with retry-after', async () => {
    const kv = memoryKv();
    const env = envFor({ RATE_LIMIT_MAX: '2', RATE_LIMIT_KV: kv });
    expect((await handle('/stats', {}, env)).status).toBe(200);
    const second = await handle('/stats', {}, env);
    expect(second.status).toBe(200);
    expect(second.headers.get('ratelimit-remaining')).toBe('0');
    const third = await handle('/stats', {}, env);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(kv.data.size).toBe(1);
  });

  it('buckets anonymous and keyed callers separately, and fails open without KV', async () => {
    const open = await handle(
      '/pool',
      {},
      envFor({ RATE_LIMIT_KV: undefined, RATE_LIMIT_MAX: '1' }),
    );
    expect(open.status).toBe(200);
    const open2 = await handle(
      '/pool',
      {},
      envFor({ RATE_LIMIT_KV: undefined, RATE_LIMIT_MAX: '1' }),
    );
    expect(open2.status).toBe(200);
  });
});

describe('caching', () => {
  it('serves a second identical request from cache without calling the origin', async () => {
    const env = envFor();
    const { ctx, flush } = makeCtx();
    await handle('/pool?limit=2', {}, env, ctx);
    await flush();
    expect(calls).toHaveLength(1);
    const cached = await handle('/pool?limit=2', {}, env, ctx);
    const body = await readJson(cached);
    await flush();
    expect(calls).toHaveLength(1);
    expect(body.meta.cached).toBe(true);
    expect(body.meta.request_id).not.toBe('req_upstream');
    expect(cached.headers.get('x-proxypulse-cached')).toBe('1');
    expect(cached.headers.get('age')).toBe('0');
  });

  it('never caches /random or /health', async () => {
    const env = envFor();
    const { ctx, flush } = makeCtx();
    await handle('/random', {}, env, ctx);
    await handle('/random', {}, env, ctx);
    await flush();
    expect(calls).toHaveLength(2);
    const first = await handle('/pool', {}, env, ctx);
    expect(first.headers.get('cache-control')).toContain('max-age=30');
  });

  it('treats a differing query string as a different cache entry', async () => {
    const env = envFor();
    const { ctx, flush } = makeCtx();
    await handle('/pool?limit=2', {}, env, ctx);
    await handle('/pool?limit=3', {}, env, ctx);
    await flush();
    expect(calls).toHaveLength(2);
    // same parameters in a different order hit the same entry
    await handle('/pool?limit=2', {}, env, ctx);
    expect(calls).toHaveLength(2);
  });

  it('serves a stale entry when the origin is down, flagged as stale', async () => {
    // seed the edge cache with an entry that is already past its TTL, then take the origin away
    const cache = memoryCache();
    await writeCache(
      cache,
      cacheKey(new URL('https://x/pool'), 'pp:/pool'),
      poolPayload(),
      30,
      Date.now() - 600_000,
    );
    const env = envFor({ __cache: cache });
    upstream = async () => new Response('boom', { status: 500 });
    vi.stubGlobal('fetch', upstream);

    const response = await handle('/pool', {}, env);
    const body = await readJson(response);
    expect(response.status).toBe(200);
    expect(body.meta.stale).toBe(true);
    expect(body.meta.cached).toBe(true);
    expect(Number(response.headers.get('age'))).toBeGreaterThan(500);
    expect(body.data.proxies).toHaveLength(2);
  });

  it('reports a clean 502 when the origin is down and nothing is cached', async () => {
    upstream = async () => new Response('', { status: 502 });
    vi.stubGlobal('fetch', upstream);
    const response = await handle('/pool', {}, envFor());
    expect(response.status).toBe(502);
    const body = await readJson(response);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('upstream_error');
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('passes through an "empty pool" 503 from the worker', async () => {
    upstream = async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: 'unavailable',
            message: 'no healthy proxies currently match the pool criteria',
          },
          meta: {},
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    vi.stubGlobal('fetch', upstream);
    const response = await handle('/random', {}, envFor());
    expect(response.status).toBe(503);
    const body = await readJson(response);
    expect(body.error.code).toBe('unavailable');
    expect(body.error.message).toContain('no healthy proxies');
  });

  it('turns a timeout into a 504 rather than hanging forever', async () => {
    upstream = async () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    };
    vi.stubGlobal('fetch', upstream);
    const response = await handle('/pool', {}, envFor());
    expect(response.status).toBe(504);
    expect((await readJson(response)).error.code).toBe('timeout');
  });

  it('refuses to pass on a non-JSON or malformed origin response', async () => {
    upstream = async () =>
      new Response('<html>nginx</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    vi.stubGlobal('fetch', upstream);
    const html = await handle('/pool', {}, envFor());
    expect(html.status).toBe(502);

    upstream = async () =>
      new Response('{ not json', { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', upstream);
    const malformed = await handle('/pool', {}, envFor());
    expect(malformed.status).toBe(502);
  });
});

describe('cron trigger (free-tier keep-alive)', () => {
  it('pokes /health without credentials in keepalive mode', async () => {
    await runCron();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://worker.internal.test/health');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('triggers a cycle when asked to, with the internal token', async () => {
    await runCron(envFor({ CYCLE_TRIGGER_MODE: 'trigger' }));
    expect(calls[0]?.url).toBe('https://worker.internal.test/internal/cycle/run');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBe('{}');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('stays silent when disabled', async () => {
    await runCron(envFor({ CYCLE_TRIGGER_ENABLED: '0' }));
    expect(calls).toHaveLength(0);
  });

  it('swallows an unreachable origin and a 409 (a cycle is already running)', async () => {
    upstream = async () => {
      throw new Error('socket hang up');
    };
    vi.stubGlobal('fetch', upstream);
    await expect(runCron()).resolves.toBeUndefined();

    upstream = async () => new Response('', { status: 409 });
    vi.stubGlobal('fetch', upstream);
    await expect(runCron(envFor({ CYCLE_TRIGGER_MODE: 'trigger' }))).resolves.toBeUndefined();
  });

  it('does nothing at all when the gateway is misconfigured', async () => {
    await expect(runCron(envFor({ RENDER_ORIGIN: '' }))).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('cache primitives', () => {
  it('expires by TTL using an injected clock', async () => {
    const cache = memoryCache();
    const key = 'pp:/pool|/pool?limit=2';
    await writeCache(cache, key, '{"ok":true}', 30, Date.parse('2026-01-01T00:00:00.000Z'));
    const fresh = await lookupCache(cache, key, 30, Date.parse('2026-01-01T00:00:20.000Z'));
    expect(fresh).toMatchObject({ hit: true, stale: false, ageSeconds: 20, status: 200 });
    const old = await lookupCache(cache, key, 30, Date.parse('2026-01-01T00:10:00.000Z'));
    expect(old).toMatchObject({ hit: true, stale: true, ageSeconds: 600 });
    expect((await lookupCache(null, key, 30)).hit).toBe(false);
    expect(ttlFor('/pool')).toBe(30);
    expect(ttlFor('/random')).toBe(0);
  });

  it('normalises the query order but not the endpoint', () => {
    expect(cacheKey(new URL('https://x/pool?b=2&a=1'))).toBe(
      cacheKey(new URL('https://x/pool?a=1&b=2')),
    );
    expect(cacheKey(new URL('https://x/pool?a=1'))).not.toBe(
      cacheKey(new URL('https://x/pool?a=2')),
    );
    expect(cacheKey(new URL('https://x/pool?bypass_cache=1&a=1'))).toBe(
      cacheKey(new URL('https://x/pool?a=1')),
    );
  });
});
