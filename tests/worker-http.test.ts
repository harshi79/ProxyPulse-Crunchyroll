/**
 * The worker's internal HTTP surface: authentication, request hygiene and the exact response
 * contract the Cloudflare gateway forwards. A real runtime is booted against an in-memory database,
 * so this exercises the wiring, not a mock of it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '@proxypulse/db';
import { loadConfig, type WorkerConfig } from '../worker/src/config';
import { createRuntime, type WorkerRuntime } from '../worker/src/runtime';
import { readJson } from './helpers/json';

const TOKEN = 'unit_test_internal_token_0123456789';
let runtime: WorkerRuntime;
let db: DbHandle;
let base = '';
const config: WorkerConfig = {} as WorkerConfig;

const auth = { authorization: `Bearer ${TOKEN}` };

const getJson = async (
  path: string,
  headers: Record<string, string> = auth,
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, { headers });
  return { status: response.status, body: await readJson(response) };
};

beforeAll(async () => {
  db = createDb({ url: ':memory:' });
  const loaded = loadConfig({
    env: {
      ENVIRONMENT: 'test',
      DATABASE_URL: 'file:./unused.db',
      INTERNAL_API_TOKEN: TOKEN,
      PROXY_SOURCES_JSON: '[]',
      POOL_MIN_SCORE: '25',
      CR_CHECK_ENABLED: '0',
      LOG_LEVEL: 'error',
    },
  });
  Object.assign(config, loaded);
  runtime = await createRuntime({
    config: loaded,
    db,
    migrate: true,
    startHttp: true,
    version: '0.0.0-test',
  });
  const { port } = await runtime.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await runtime?.stop();
  db?.close();
});

describe('liveness', () => {
  it('answers /health without a token and reports the database', async () => {
    const { status, body } = await getJson('/health', {});
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.database.ok).toBe(true);
    expect(body.data.scheduler.interval_minutes).toBe(15);
    expect(body.data.version).toBe('0.0.0-test');
  });

  it('answers /ready', async () => {
    const { status, body } = await getJson('/ready', {});
    expect(status).toBe(200);
    expect(body.data.ready).toBe(true);
  });

  it('exposes prometheus style metrics to the token holder', async () => {
    const response = await fetch(`${base}/internal/metrics`);
    expect(response.status).toBe(401);
    const metrics = await fetch(`${base}/internal/metrics`, { headers: auth });
    const text = await metrics.text();
    expect(metrics.status).toBe(200);
    expect(text).toContain('proxypulse_up 1');
    expect(text).toContain('proxypulse_pool_size');
    expect(text).toContain('# TYPE proxypulse_proxies gauge');
  });
});

describe('authentication and hygiene', () => {
  it('rejects missing, malformed and wrong tokens', async () => {
    expect((await getJson('/internal/pool', {})).status).toBe(401);
    expect((await getJson('/internal/pool', { authorization: 'Bearer' })).status).toBe(401);
    expect((await getJson('/internal/pool', { authorization: 'Basic Zm9vOmJhcg==' })).status).toBe(
      401,
    );
    expect(
      (await getJson('/internal/pool', { authorization: `Bearer ${TOKEN.slice(0, -2)}` })).status,
    ).toBe(401);
    const { body } = await getJson('/internal/pool', {});
    expect(body.error.code).toBe('unauthorized');
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('accepts the header variant the gateway uses', async () => {
    const response = await fetch(`${base}/internal/tpool`, {
      headers: { 'x-proxypulse-internal-token': TOKEN },
    });
    expect(response.status).toBe(200);
  });

  it('returns 404 for unknown routes and 405 for the wrong method', async () => {
    expect((await getJson('/internal/nope')).status).toBe(404);
    expect((await getJson('/', {})).status).toBe(404);
    const post = await fetch(`${base}/internal/pool`, { method: 'POST', headers: auth });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
  });

  it('echoes a request id and adds one when the client sent nonsense', async () => {
    const mine = await fetch(`${base}/health`, { headers: { 'x-request-id': 'req_trace_me_1' } });
    expect(mine.headers.get('x-request-id')).toBe('req_trace_me_1');
    const junk = await fetch(`${base}/health`, { headers: { 'x-request-id': '../../etc/passwd' } });
    const generated = junk.headers.get('x-request-id') ?? '';
    expect(generated).toMatch(/^req_/);
  });

  it('refuses oversized and non-JSON bodies', async () => {
    const huge = await fetch(`${base}/internal/cycle/run`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(200_000) }),
    });
    expect(huge.status).toBe(413);
    const junk = await fetch(`${base}/internal/cycle/run`, {
      method: 'POST',
      headers: auth,
      body: 'not json at all',
    });
    expect(junk.status).toBe(400);
  });

  it('never leaks the token or internal config in error payloads', async () => {
    const { status, body } = await getJson('/internal/pool?protocol=bogus', {});
    expect(status).toBe(401);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain('DATABASE_URL');
    const rejected = await getJson('/internal/pool?protocol=bogus');
    expect(rejected.body.error.message).toBe(
      'invalid protocol "bogus" (expected http, https, socks4 or socks5)',
    );
  });
});

describe('pool views over an empty database', () => {
  it('reports an empty pool instead of failing', async () => {
    const { status, body } = await getJson('/internal/pool?limit=10');
    expect(status).toBe(200);
    expect(body.data.proxies).toEqual([]);
    expect(body.data.pool_size).toBe(0);
    expect(body.meta.pool_size).toBe(0);
    expect(body.meta.request_id).toBeTruthy();
    expect(Date.parse(body.meta.timestamp)).not.toBeNaN();
  });

  it('returns 503 from /random when nothing qualifies', async () => {
    const { status, body } = await getJson('/internal/random');
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unavailable');
  });

  it('validates filters at the edge of the worker too', async () => {
    for (const query of [
      'protocol=ftp',
      'country=USA',
      'service=maybe',
      'limit=-3',
      'offset=abc',
    ]) {
      const { status } = await getJson(`/internal/pool?${query}`);
      expect([200, 400]).toContain(status);
    }
    expect((await getJson('/internal/pool?protocol=ftp')).status).toBe(400);
    expect((await getJson('/internal/pool?country=USA')).status).toBe(400);
  });

  it('clamps a huge page size and reports the warning', async () => {
    const { status, body } = await getJson('/internal/pool?limit=100000');
    expect(status).toBe(200);
    expect(body.data.limit).toBe(500);
    expect(body.data.warnings.join(' ')).toContain('clamped');
  });

  it('describes the service summary in the tpool shape', async () => {
    const { body } = await getJson('/internal/tpool');
    expect(Object.keys(body.data).sort()).toEqual([
      'cycle',
      'last_check',
      'next_check',
      'service',
      'valid',
    ]);
    expect(body.data.service).toBe('crunchyroll');
    expect(body.data.valid).toBe(0);
    expect(body.data.next_check).toBeTruthy();
  });

  it('serves stats with the pool, refresh and service sections', async () => {
    const { body } = await getJson('/internal/stats');
    expect(body.data.pool.min_score).toBe(25);
    expect(body.data.refresh.interval_minutes).toBe(15);
    expect(body.data.service_check.enabled).toBe(false);
    expect(body.data.by_protocol).toMatchObject({ http: 0, socks5: 0 });
    expect(body.data.worker.environment).toBe('test');
  });

  it('lists cycles (empty at first)', async () => {
    const { body } = await getJson('/internal/cycles?limit=3');
    expect(body.data.cycles).toEqual([]);
  });
});

describe('cycle triggering', () => {
  it('runs a cycle on demand and records it', async () => {
    const started = await fetch(`${base}/internal/cycle/run?wait=1`, {
      method: 'POST',
      headers: auth,
    });
    expect(started.status).toBe(202);
    const payload = await readJson(started);
    expect(payload.data.started).toBe(true);

    const { body } = await getJson('/internal/cycles?limit=5');
    expect(body.data.cycles).toHaveLength(1);
    const cycle = body.data.cycles[0];
    expect(cycle.status).toBe('completed');
    expect(cycle.candidates_discovered).toBe(0);
    expect(cycle.duration_ms).toBeGreaterThanOrEqual(0);
    expect(cycle.cycle_id).toBeTruthy();
  });

  it('rejects job payloads that are missing an id or use an unknown type', async () => {
    const bad = await fetch(`${base}/internal/jobs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ type: 'VALIDATE' }),
    });
    expect(bad.status).toBe(400);
    const unknownType = await fetch(`${base}/internal/jobs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ type: 'WORLD_DOMINATION', proxy_id: 1 }),
    });
    expect(unknownType.status).toBe(400);
    // a well formed job for a proxy that does not exist is accepted (the queue owns it) and fails
    // inside the consumer, where the error is logged rather than returned
    const accepted = await fetch(`${base}/internal/jobs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ type: 'VALIDATE', proxy_id: 999_999, reason: 'manual' }),
    });
    expect(accepted.status).toBe(202);
    const body = await readJson(accepted);
    expect(body.data.job_id).toMatch(/^job_/);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
