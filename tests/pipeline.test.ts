/**
 * The full cycle, in-process: discovery → policy filter → dedupe/upsert → validation → service check →
 * scoring → rolling pool → persistence. Everything runs against the loopback mocks and a throwaway
 * SQLite database, so the assertions cover real SQL, real sockets and real state transitions.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, META_KEYS, type DbHandle } from '@proxypulse/db';
import { createRuntime, type WorkerRuntime } from '../worker/src/runtime';
import { statsView, tpoolView, poolView, randomView } from '../worker/src/views';
import { startMockProxy, startMockTarget, type StartedProcess } from './helpers/servers';

const FIXTURE_LINES = 6;

let dir: string;
let target: StartedProcess;
let httpProxy: StartedProcess;
let socks5Proxy: StartedProcess;
let socks4Proxy: StartedProcess;
let rejecting: StartedProcess;
let hanging: StartedProcess;
let authed: StartedProcess;
let runtime: WorkerRuntime;
let db: DbHandle;
const servers: StartedProcess[] = [];

const start = async (label: string, proc: StartedProcess): Promise<StartedProcess> => {
  servers.push(proc);
  void label;
  return proc;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'proxypulse-pipeline-'));
  [target, httpProxy, socks5Proxy, socks4Proxy, rejecting, hanging, authed] = await Promise.all([
    startMockTarget().then((proc) => start('target', proc)),
    startMockProxy('http').then((proc) => start('http', proc)),
    startMockProxy('socks5').then((proc) => start('socks5', proc)),
    startMockProxy('socks4').then((proc) => start('socks4', proc)),
    startMockProxy('http', { mode: 'reject' }).then((proc) => start('reject', proc)),
    startMockProxy('http', { mode: 'hang' }).then((proc) => start('hang', proc)),
    startMockProxy('http', { requireAuth: 'pipeuser:sup3rsecret' }).then((proc) =>
      start('auth', proc),
    ),
  ]);

  const fixture = [
    `http://127.0.0.1:${httpProxy.port}`,
    `socks5://127.0.0.1:${socks5Proxy.port}`,
    `socks4://127.0.0.1:${socks4Proxy.port}`,
    `http://pipeuser:sup3rsecret@127.0.0.1:${authed.port}`,
    `http://127.0.0.1:${rejecting.port}`,
    `http://127.0.0.1:${hanging.port}`,
    // noise that must be counted, not crashed on
    'this line is not a proxy',
    '1.2.3',
    `http://127.0.0.1:${httpProxy.port}`,
  ].join('\n');
  writeFileSync(join(dir, 'proxies.txt'), `${fixture}\n`);

  db = createDb({ url: ':memory:' });
  const config = (await import('../worker/src/config')).loadConfig({
    env: {
      ENVIRONMENT: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL: `file:${join(dir, 'pipe.db')}`,
      INTERNAL_API_TOKEN: 'pipeline_test_token_0123456789',
      PROXY_SOURCES_JSON: JSON.stringify([
        { id: 'fixture-source', kind: 'local-file', path: join(dir, 'proxies.txt'), trust: 0.8 },
      ]),
      ALLOW_PRIVATE_ENDPOINTS: '1',
      VALIDATION_CONCURRENCY: '3',
      VALIDATION_TIMEOUT_MS: '700',
      VALIDATION_CONNECT_TIMEOUT_MS: '400',
      VALIDATION_RETRIES: '1',
      VALIDATION_BACKOFF_MS: '10',
      VALIDATION_CHECK_URL: `http://127.0.0.1:${target.port}/generate_204`,
      VALIDATION_MAX_PER_CYCLE: '100',
      POOL_MIN_SCORE: '0',
      POOL_TTL_MINUTES: '90',
      POOL_RECHECK_AFTER_MINUTES: '1',
      POOL_MAX_NEW_PER_CYCLE: '50',
      POOL_REQUIRE_SERVICE_PASS: '0',
      CR_CHECK_ENABLED: '1',
      CR_CHECK_SCHEME: 'http',
      CR_CHECK_URL: `http://127.0.0.1:${target.port}/ok`,
      CR_ALLOWED_HOSTS: '127.0.0.1',
      CR_RESPECT_ROBOTS: '1',
      CR_TIMEOUT_MS: '800',
      CR_MAX_CHECKS_PER_CYCLE: '10',
      CR_MIN_REQUEST_SPACING_MS: '0',
      REFRESH_INTERVAL_MINUTES: '15',
      RUN_CYCLE_ON_STARTUP: '0',
      QUEUE_DRIVER: 'memory',
    },
    cwd: dir,
  });
  runtime = await createRuntime({ config, db, startHttp: false, cwd: dir, version: 'test' });
}, 120_000);

afterAll(async () => {
  await runtime?.stop().catch(() => undefined);
  db?.close();
  await Promise.all(servers.map((proc) => proc?.stop().catch(() => undefined)));
  rmSync(dir, { recursive: true, force: true });
});

const rows = async (): Promise<Record<string, string | number | null>[]> =>
  (
    await db.all<Record<string, string | number | null>>(
      'SELECT * FROM proxies ORDER BY host, port',
    )
  ).map((row) => {
    const clean: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof key === 'string')
        clean[key] = typeof value === 'bigint' ? Number(value) : (value as string | number | null);
    }
    return clean;
  });

describe('one refresh cycle', () => {
  it('discovers, validates, scores and persists a rolling pool', async () => {
    const report = await runtime.runCycle({ trigger: 'manual' });
    expect(report.status).toBe('completed');

    // discovery: six endpoints parsed, one duplicate collapsed, malformed noise counted
    expect(report.discovery).toMatchObject({
      sources: 1,
      sources_ok: 1,
      sources_failed: 0,
      accepted: FIXTURE_LINES,
      duplicates: 1,
      rejected: 1,
    });
    expect(report.discovery.inserted).toBe(FIXTURE_LINES);
    expect(report.discovery.blocked_by_policy).toBe(0);

    // validation: three forwarders + the authenticated proxy pass, the two broken ones fail
    expect(report.validation.checked).toBe(FIXTURE_LINES);
    expect(report.validation.passed).toBe(4);
    expect(report.validation.failed).toBe(2);
    expect(report.validation.added).toBe(4);

    // service checks ran through the real adapter, one probe per eligible proxy
    expect(report.service.checked).toBeGreaterThanOrEqual(1);
    expect(report.service.passed).toBeGreaterThanOrEqual(1);

    const stored = await rows();
    expect(stored).toHaveLength(FIXTURE_LINES);
    const byPort = new Map(stored.map((row) => [`${row.host}:${row.port}`, row]));
    const healthy = byPort.get(`127.0.0.1:${httpProxy.port}`);
    expect(healthy?.status).toBe('active');
    expect(healthy?.validation_status).toBe('passed');
    expect(healthy?.service_status).toBe('passed');
    expect(Number(healthy?.score)).toBeGreaterThan(0);
    expect(Number(healthy?.latency_ms)).toBeLessThan(700);
    expect(healthy?.first_seen).toBeTruthy();
    expect(healthy?.last_passed_at).toBeTruthy();
    expect(healthy?.consecutive_failures).toBe(0);
    expect(healthy?.password).toBeNull();

    const authedRow = byPort.get(`127.0.0.1:${authed.port}`);
    expect(authedRow?.status).toBe('active');
    expect(authedRow?.username).toBe('pipeuser');
    expect(typeof authedRow?.password).toBe('string');

    const broken = byPort.get(`127.0.0.1:${rejecting.port}`);
    expect(broken?.status).toBe('new');
    expect(broken?.validation_status).toBe('failed');
    expect(broken?.last_error_code).toBe('unexpected_status');
    expect(broken?.score).toBe(0);

    const stuck = byPort.get(`127.0.0.1:${hanging.port}`);
    expect(stuck?.last_error_code).toBe('timeout');

    // the socks variants are represented too
    expect(byPort.get(`127.0.0.1:${socks5Proxy.port}`)?.protocol).toBe('socks5');
    expect(byPort.get(`127.0.0.1:${socks4Proxy.port}`)?.protocol).toBe('socks4');

    // the cycle row + snapshots
    const cycle = await runtime.cycles.latestCompleted();
    expect(cycle).not.toBeNull();
    expect(cycle?.cycle_id).toBe(report.cycle_id);
    expect(cycle?.candidates_checked).toBe(FIXTURE_LINES);
    expect(cycle?.candidates_passed).toBe(4);
    expect(cycle?.pool_size).toBe(4);
    expect(cycle?.duration_ms).toBeGreaterThanOrEqual(0);

    const snapshot = await runtime.meta.getJson<Record<string, unknown>>(META_KEYS.statsSnapshot);
    expect(Number(snapshot?.pool_size)).toBe(4);
    expect(await runtime.meta.get(META_KEYS.currentCycleId)).toBeNull();

    const results = await db.all<{ count: number }>(
      'SELECT COUNT(*) AS count FROM validation_results',
    );
    expect(Number(results[0]?.count ?? 0)).toBe(FIXTURE_LINES);
    const serviceResults = await db.all<{ count: number }>(
      'SELECT COUNT(*) AS count FROM service_results',
    );
    expect(Number(serviceResults[0]?.count ?? 0)).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it('exposes the pool through the API views with no credentials', async () => {
    const pool = await poolView(runtime.views, new URLSearchParams('limit=10'));
    expect(pool.status).toBe(200);
    const data = pool.data as { proxies: Record<string, unknown>[]; pool_size: number };
    expect(data.pool_size).toBe(4);
    expect(data.proxies).toHaveLength(4);
    for (const entry of data.proxies) {
      expect(Object.keys(entry).sort()).toEqual([
        'anonymity',
        'country',
        'host',
        'id',
        'last_passed',
        'latency_ms',
        'port',
        'protocol',
        'score',
        'source',
      ]);
      expect(entry.password).toBeUndefined();
      expect(entry.username).toBeUndefined();
    }
    const serialised = JSON.stringify(pool);
    expect(serialised).not.toContain('sup3rsecret');
    expect(serialised).not.toContain('pipeuser');
    expect(serialised).not.toContain('password');

    const random = await randomView(runtime.views, new URLSearchParams());
    expect(random.status).toBe(200);
    expect((random.data as { proxy: { host: string } }).proxy.host).toBe('127.0.0.1');

    const stats = await statsView(runtime.views, new URLSearchParams());
    const statsData = stats.data as {
      pool_size: number;
      refresh: { interval_minutes: number };
      by_protocol: Record<string, number>;
    };
    expect(statsData.pool_size).toBe(4);
    expect(statsData.refresh.interval_minutes).toBe(15);
    expect(statsData.by_protocol.http).toBeGreaterThanOrEqual(2);
    expect(statsData.by_protocol.socks5).toBeGreaterThanOrEqual(1);
  });

  it('reports the tpool summary for the latest test cycle', async () => {
    const tpool = await tpoolView(runtime.views);
    const data = tpool.data as {
      service: string;
      valid: number;
      last_check: string | null;
      next_check: string | null;
    };
    expect(data.service).toBe('crunchyroll');
    expect(data.valid).toBeGreaterThan(0);
    expect(data.last_check).toBeTruthy();
    expect(Date.parse(String(data.next_check))).toBeGreaterThan(
      Date.parse(String(data.last_check)),
    );
  });

  it('keeps the pool rolling: fresh members are not re-probed and nothing is rebuilt', async () => {
    const before = await rows();
    const byId = new Map(before.map((row) => [Number(row.id), row]));

    const second = await runtime.runCycle({ trigger: 'manual' });
    expect(second.status).toBe('completed');
    // nothing new to learn from discovery, and the healthy members are still within their recheck window
    expect(second.discovery.inserted).toBe(0);
    expect(second.validation.added).toBe(0);
    expect(second.validation.queued).toBe(2);
    expect(second.pool.size).toBe(4);

    const after = await rows();
    expect(after).toHaveLength(FIXTURE_LINES);
    for (const row of after) {
      const original = byId.get(Number(row.id));
      // same row, same first_seen: the pool is updated in place, never deleted and re-added
      expect(String(row.first_seen)).toBe(String(original?.first_seen));
      if (Number(row.status) === 0 || row.status === 'active') {
        expect(Number(row.check_count)).toBe(Number(original?.check_count));
      } else {
        expect(Number(row.check_count)).toBeGreaterThan(Number(original?.check_count));
      }
    }
    const cycles = await runtime.cycles.list(10);
    expect(cycles.length).toBeGreaterThanOrEqual(2);
  }, 90_000);

  it('quarantines a proxy that keeps failing across cycles', async () => {
    for (let index = 0; index < 2; index++) {
      const report = await runtime.runCycle({ trigger: 'manual' });
      expect(report.validation.failed).toBeGreaterThanOrEqual(2);
    }
    const stored = await rows();
    const broken = stored.find((row) => Number(row.port) === rejecting.port);
    // 4 consecutive failures at the default threshold of 3 => quarantined, and still present
    expect(broken?.status).toBe('quarantined');
    expect(Number(broken?.consecutive_failures)).toBeGreaterThanOrEqual(4);
    const healthy = stored.find((row) => Number(row.port) === httpProxy.port);
    expect(healthy?.status).toBe('active');
  }, 120_000);

  it('runs a single proxy on request through the job path', async () => {
    const stored = await rows();
    const target = stored.find((row) => Number(row.port) === hanging.port)!;
    const before = String(target.last_checked_at);
    await runtime.pipeline.handleExternalJob({
      job_id: 'job_manual_1',
      type: 'VALIDATE',
      cycle_id: 'cyc_manual',
      issued_at: new Date().toISOString(),
      proxy_id: Number(target.id),
    });
    const after = await rows();
    const updated = after.find((row) => Number(row.id) === Number(target.id))!;
    expect(String(updated.last_checked_at)).not.toBe(before);
    expect(updated.last_error_code).toBe('timeout');
  }, 60_000);
});

describe('fixture sanity', () => {
  it('the fixture file the cycle read is the one we wrote', () => {
    const text = readFileSync(join(dir, 'proxies.txt'), 'utf8');
    expect(text.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(
      FIXTURE_LINES + 3,
    );
  });
});
