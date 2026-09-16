import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyMigrations,
  assertSchemaReady,
  createDb,
  CyclesRepository,
  findMigrationsDir,
  META_KEYS,
  MetaRepository,
  ProxiesRepository,
  readMigrations,
  ServiceResultsRepository,
  splitSqlStatements,
  ValidationResultsRepository,
  type DbHandle,
} from '@proxypulse/db';
import { type NormalizedProxy } from '@proxypulse/shared';

const NOW = '2026-09-14T10:45:00.000Z';
const nowMs = Date.parse(NOW);

let db: DbHandle;
let proxies: ProxiesRepository;
let cycles: CyclesRepository;
let meta: MetaRepository;
let validations: ValidationResultsRepository;
let services: ServiceResultsRepository;

const candidate = (
  host: string,
  port = 8080,
  overrides: Partial<NormalizedProxy> = {},
): NormalizedProxy => ({
  host,
  port,
  protocol: 'http',
  anonymity: 'unknown',
  ...overrides,
});

beforeAll(async () => {
  db = createDb({ url: ':memory:' });
  const result = await applyMigrations(db, { dir: findMigrationsDir() });
  expect(result.applied.length).toBeGreaterThan(0);
  proxies = new ProxiesRepository(db);
  cycles = new CyclesRepository(db);
  meta = new MetaRepository(db);
  validations = new ValidationResultsRepository(db);
  services = new ServiceResultsRepository(db);
});

afterAll(() => {
  db.close();
});

describe('migrations', () => {
  it('creates every required table and is idempotent', async () => {
    const ready = await assertSchemaReady(db);
    expect(ready.missing).toEqual([]);
    expect(ready.tables).toEqual(
      expect.arrayContaining([
        'proxies',
        'validation_results',
        'service_results',
        'refresh_cycles',
        'meta',
      ]),
    );

    const second = await applyMigrations(db, { dir: findMigrationsDir() });
    expect(second.applied).toEqual([]);
    expect(second.already_applied.length).toBeGreaterThan(0);
  });

  it('ships migrations with numeric prefixes and splits statements safely', () => {
    const files = readMigrations(findMigrationsDir());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file.name).toMatch(/^\d+_[a-z0-9_]+\.sql$/);
    const statements = splitSqlStatements(files[0]!.sql);
    expect(statements.length).toBeGreaterThan(5);
    expect(statements.every((statement) => !statement.includes(';'))).toBe(true);
    expect(statements.some((statement) => statement.startsWith('CREATE INDEX'))).toBe(true);
  });

  it('keeps a schema version in meta-ish bookkeeping', async () => {
    const row = await db.get<{ name: string }>('SELECT MAX(name) AS name FROM _schema_migrations');
    expect(row?.name).toMatch(/^0\d\d_/);
  });
});

describe('proxy upsert + deduplication', () => {
  it('inserts unique candidates and touches re-discovered ones', async () => {
    const result = await proxies.upsertCandidates(
      [
        { proxy: candidate('203.0.113.1'), source: 'fixture_a' },
        { proxy: candidate('203.0.113.2'), source: 'fixture_a' },
        { proxy: candidate('203.0.113.2'), source: 'fixture_b' }, // same host:port, same protocol
        { proxy: candidate('203.0.113.3'), source: 'fixture_b' },
      ],
      'cyc_first',
      NOW,
    );
    expect(result.total).toBe(3);
    expect(result.inserted).toBe(3);

    const again = await proxies.upsertCandidates(
      [{ proxy: candidate('203.0.113.1'), source: 'fixture_b' }],
      'cyc_second',
      NOW,
    );
    expect(again.inserted).toBe(0);
    expect(again.touched).toBe(1);

    const row = await db.get<{ source: string; first_seen: string }>(
      `SELECT source, first_seen FROM proxies WHERE host = '203.0.113.1'`,
    );
    expect(row?.first_seen).toBe(NOW);

    const counts = await proxies.countByStatus();
    expect(counts.total).toBe(3);
    expect(counts.new).toBe(3);
  });

  it('treats a different username as a different proxy and never dedupes by hash collision', async () => {
    const before = (await proxies.countByStatus()).total;
    await proxies.upsertCandidates(
      [
        {
          proxy: candidate('203.0.113.9', 1080, { username: 'alice', password: 'x' }),
          source: 'private_seed',
        },
        {
          proxy: candidate('203.0.113.9', 1080, { username: 'bob', password: 'y' }),
          source: 'private_seed',
        },
        { proxy: candidate('203.0.113.9', 1080), source: 'private_seed' },
      ],
      'cyc_auth',
      NOW,
    );
    const after = (await proxies.countByStatus()).total;
    expect(after - before).toBe(3);
  });
});

describe('validation queue', () => {
  it('prefers never-checked rows, then quarantined, then stale pool members', async () => {
    const queue = await proxies.selectValidationQueue({
      newLimit: 2,
      quarantineLimit: 5,
      recheckLimit: 5,
      recheckAfterMinutes: 15,
      nowIso: NOW,
    });
    expect(queue.length).toBe(2);
    expect(queue.every((row) => row.status === 'new')).toBe(true);

    await proxies.markPending(
      queue.map((row) => row.id),
      'cyc_queue',
    );
    const pending = await proxies.countByStatus();
    expect(pending.pending).toBe(2);

    // rows claimed by the cycle are never re-queued in the same cycle
    const claimed = queue.map((row) => row.id);
    const second = await proxies.selectValidationQueue({
      newLimit: 20,
      quarantineLimit: 20,
      recheckLimit: 20,
      recheckAfterMinutes: 15,
      nowIso: NOW,
    });
    for (const id of claimed) expect(second.map((row) => row.id)).not.toContain(id);

    // a crashed cycle releases its claims again
    expect(await proxies.releaseOrphanedPending('cyc_queue')).toBe(2);
    expect((await proxies.countByStatus()).new).toBe(6);
  });
});

describe('validation outcomes and pool state', () => {
  const byHost = async (host: string) =>
    db.get<{
      id: number;
      status: string;
      score: number;
      latency_ms: number | null;
      consecutive_failures: number;
      check_count: number;
      pass_count: number;
    }>(
      `SELECT id, status, score, latency_ms, consecutive_failures, check_count, pass_count FROM proxies WHERE host = ?`,
      [host],
    );

  it('persists a pass and makes the proxy pool eligible', async () => {
    const target = await byHost('203.0.113.1');
    expect(target).not.toBeNull();
    await proxies.persistValidationOutcomes([
      {
        id: target!.id,
        cycle_id: 'cyc_outcome',
        created_at: NOW,
        reachable: true,
        latency_ms: 180,
        protocol: 'http',
        transport: 'absolute-form',
        http_status: 204,
        error_code: null,
        error_message: null,
        attempts: 1,
        duration_ms: 190,
        status: 'active',
        validation_status: 'passed',
        consecutive_failures: 0,
        score: 82.5,
        service_status: 'untested',
      },
    ]);
    const row = await byHost('203.0.113.1');
    expect(row?.status).toBe('active');
    expect(row?.score).toBe(82.5);
    expect(row?.pass_count).toBe(1);

    const pool = await proxies.readPool({
      limit: 10,
      offset: 0,
      protocol: null,
      minScore: 0,
      maxLatencyMs: null,
      country: null,
      service: 'off',
      ttlMinutes: 90,
      nowIso: NOW,
    });
    expect(pool.total).toBe(1);
    expect(pool.entries[0]).toMatchObject({
      host: '203.0.113.1',
      port: 8080,
      protocol: 'http',
      score: 82.5,
    });
    expect(pool.entries[0]).not.toHaveProperty('username');
    expect(pool.entries[0]).not.toHaveProperty('password');
    expect(JSON.stringify(pool)).not.toContain('password');
  });

  it('records a failure and increments consecutive failures', async () => {
    const target = await byHost('203.0.113.2');
    await validations.insertMany([
      {
        proxy_id: target!.id,
        cycle_id: 'cyc_outcome',
        created_at: NOW,
        reachable: false,
        latency_ms: null,
        protocol: 'http',
        transport: null,
        http_status: null,
        error_code: 'timeout',
        error_message: 'connect timed out',
        attempts: 2,
        duration_ms: 4_000,
      },
    ]);
    await proxies.persistValidationOutcomes([
      {
        id: target!.id,
        cycle_id: 'cyc_outcome',
        created_at: NOW,
        reachable: false,
        latency_ms: null,
        protocol: 'http',
        transport: null,
        http_status: null,
        error_code: 'timeout',
        error_message: null,
        attempts: 2,
        duration_ms: 4_000,
        status: 'quarantined',
        validation_status: 'failed',
        consecutive_failures: 3,
        score: 0,
        service_status: 'untested',
      },
    ]);
    const row = await byHost('203.0.113.2');
    expect(row?.status).toBe('quarantined');
    expect(row?.check_count).toBe(1);
    expect(row?.pass_count).toBe(0);
    const breakdown = await validations.errorBreakdown('cyc_outcome');
    // one row from the explicit insertMany, one from persistValidationOutcomes
    expect(breakdown).toEqual([{ error_code: 'timeout', count: 2 }]);

    // a quarantined proxy is never returned through the pool
    const pool = await proxies.readPool({
      limit: 10,
      offset: 0,
      protocol: null,
      minScore: 0,
      maxLatencyMs: null,
      country: null,
      service: 'off',
      ttlMinutes: 90,
      nowIso: NOW,
    });
    expect(pool.entries.map((entry) => entry.host)).toEqual(['203.0.113.1']);
  });

  it('excludes expired entries and honours filters', async () => {
    const stale = new Date(nowMs - 10 * 60 * 60 * 1000).toISOString();
    await db.run(`UPDATE proxies SET last_passed_at = ? WHERE host = '203.0.113.1'`, [stale]);
    const pool = await proxies.readPool({
      limit: 10,
      offset: 0,
      protocol: null,
      minScore: 0,
      maxLatencyMs: null,
      country: null,
      service: 'off',
      ttlMinutes: 90,
      nowIso: NOW,
    });
    expect(pool.total).toBe(0);

    // expireStale flips long-unverified pool members to dead
    await db.run(`UPDATE proxies SET last_passed_at = ? WHERE host = '203.0.113.1'`, [stale]);
    expect(await proxies.expireStale({ ttlMinutes: 90, nowIso: NOW })).toBe(1);
    const row = await db.get<{ status: string; last_error_code: string | null }>(
      `SELECT status, last_error_code FROM proxies WHERE host = '203.0.113.1'`,
    );
    expect(row).toEqual({ status: 'dead', last_error_code: 'expired' });

    // revive and exercise the filter set
    await db.run(
      `UPDATE proxies SET status = 'active', last_passed_at = ?, score = 90, latency_ms = 100, country = 'DE', service_status = 'passed'
        WHERE host = '203.0.113.1'`,
      [NOW],
    );
    const all = await proxies.readPool({
      limit: 10,
      offset: 0,
      protocol: null,
      minScore: 0,
      maxLatencyMs: null,
      country: null,
      service: 'required',
      ttlMinutes: 90,
      nowIso: NOW,
    });
    expect(all.entries).toHaveLength(1);

    const wrongProtocol = await proxies.readPool({
      limit: 10,
      offset: 0,
      protocol: 'socks5',
      minScore: 0,
      maxLatencyMs: null,
      country: null,
      service: 'off',
      ttlMinutes: 90,
      nowIso: NOW,
    });
    expect(wrongProtocol.entries).toHaveLength(0);

    const tooStrict = await proxies.readPool({
      limit: 10,
      offset: 0,
      protocol: null,
      minScore: 95,
      maxLatencyMs: 50,
      country: null,
      service: 'off',
      ttlMinutes: 90,
      nowIso: NOW,
    });
    expect(tooStrict.entries).toHaveLength(0);

    const byCountry = await proxies.readPool({
      limit: 10,
      offset: 0,
      protocol: null,
      minScore: 0,
      maxLatencyMs: null,
      country: 'de',
      service: 'off',
      ttlMinutes: 90,
      nowIso: NOW,
    });
    expect(byCountry.entries[0]?.country).toBe('DE');
  });

  it('quarantines repeated failures and enforces pool capacity', async () => {
    // start from a clean slate so the sweeps only see the rows created here
    await db.run(`UPDATE proxies SET status = 'dead'`);
    await db.run(
      `INSERT INTO proxies (dedupe_key, host, port, protocol, source, status, score, first_seen, last_seen, last_checked_at, last_passed_at, consecutive_failures, check_count, pass_count)
       VALUES ('k1','198.51.100.1',80,'http','fixture','active',70,?,?,?, ?,0,1,1),
              ('k2','198.51.100.2',80,'http','fixture','active',60,?,?,?, ?,0,1,1),
              ('k3','198.51.100.3',80,'http','fixture','active',50,?,?,?, ?,0,1,1)`,
      [NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW],
    );
    expect(await proxies.quarantineFailures({ maxConsecutiveFailures: 3 })).toBe(0);

    await db.run(`UPDATE proxies SET consecutive_failures = 3 WHERE host = '198.51.100.1'`);
    expect(await proxies.quarantineFailures({ maxConsecutiveFailures: 3 })).toBe(1);
    const quarantined = await db.get<{ status: string }>(
      `SELECT status FROM proxies WHERE host = '198.51.100.1'`,
    );
    expect(quarantined?.status).toBe('quarantined');

    await db.run(
      `UPDATE proxies SET consecutive_failures = 0, status = 'active' WHERE host LIKE '198.51.100.%'`,
    );
    expect(await proxies.enforcePoolCapacity(2)).toBe(1);
    const activeCount = await db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM proxies WHERE status = 'active'`,
    );
    expect(activeCount?.count).toBe(2);
    const demoted = await db.get<{ host: string; notes: string }>(
      `SELECT host, notes FROM proxies WHERE status = 'quarantined' AND notes = 'quarantined: pool capacity'`,
    );
    expect(demoted?.host).toBe('198.51.100.3'); // lowest score is demoted first
  });

  it('uses an index for pool reads', async () => {
    const plan = await db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT id FROM proxies WHERE status = 'active' AND score >= 0 ORDER BY score DESC LIMIT 10`,
    );
    expect(plan.map((row) => row.detail).join(' ')).toMatch(/idx_proxies/);
  });
});

describe('service results', () => {
  it('persists a service verdict and exposes aggregates', async () => {
    const row = await db.get<{ id: number }>(`SELECT id FROM proxies WHERE host = '203.0.113.1'`);
    await proxies.persistServiceOutcomes('crunchyroll', [
      {
        id: row!.id,
        cycle_id: 'cyc_service',
        service: 'crunchyroll',
        created_at: NOW,
        passed: true,
        status: 'passed',
        http_status: 200,
        latency_ms: 240,
        reason: null,
        details: '{"allowed_by_robots":true}',
        score: 95,
        status_next: 'active',
      },
    ]);
    const summary = await services.summary('cyc_service', 'crunchyroll');
    expect(summary).toMatchObject({
      checked: 1,
      passed: 1,
      failed: 0,
      blocked: 0,
      avg_latency_ms: 240,
    });
    expect(
      await services.countCurrentlyValid({ service: 'crunchyroll', ttlMinutes: 90, nowIso: NOW }),
    ).toBe(1);

    const stored = await db.get<{ service_checked_at: string; service_status: string }>(
      `SELECT service_checked_at, service_status FROM proxies WHERE id = ?`,
      [row!.id],
    );
    expect(stored?.service_status).toBe('passed');
    expect(stored?.service_checked_at).toBe(NOW);
  });
});

describe('cycles and meta', () => {
  it('tracks the cycle lifecycle and recovers abandoned runs', async () => {
    await cycles.start('cyc_live', NOW);
    expect((await cycles.current())?.cycle_id).toBe('cyc_live');
    expect(await cycles.latestCompleted()).toBeNull();

    await cycles.complete('cyc_live', {
      finished_at: new Date(nowMs + 65_000).toISOString(),
      candidates_discovered: 100,
      candidates_new: 90,
      candidates_checked: 95,
      candidates_passed: 40,
      candidates_failed: 55,
      service_checked: 30,
      service_passed: 25,
      pool_size: 12,
      pool_added: 9,
      pool_quarantined: 2,
      pool_expired: 1,
      duration_ms: 65_000,
      error: null,
    });
    expect(await cycles.current()).toBeNull();
    const latest = await cycles.latestCompleted();
    expect(latest).toMatchObject({
      cycle_id: 'cyc_live',
      status: 'completed',
      candidates_discovered: 100,
      pool_size: 12,
    });

    await cycles.start('cyc_crash', NOW);
    expect(await cycles.recoverAbandoned(NOW)).toBe(1);
    const failed = await cycles.get('cyc_crash');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('abandoned');
  });

  it('stores scheduling metadata as JSON', async () => {
    await meta.set(META_KEYS.nextRunAt, NOW);
    expect(await meta.get(META_KEYS.nextRunAt)).toBe(NOW);
    await meta.setJson(META_KEYS.statsSnapshot, { pool_size: 3, computed_at: NOW });
    expect(await meta.getJson<{ pool_size: number }>(META_KEYS.statsSnapshot)).toEqual({
      pool_size: 3,
      computed_at: NOW,
    });
    await meta.remove(META_KEYS.statsSnapshot);
    expect(await meta.getJson(META_KEYS.statsSnapshot)).toBeNull();
  });
});

describe('pool statistics', () => {
  it('reports aggregate statistics for the current pool', async () => {
    await db.run('UPDATE proxies SET status = ? WHERE status IS NOT NULL', ['dead']);
    await db.run(
      `INSERT INTO proxies (dedupe_key, host, port, protocol, source, status, score, latency_ms, check_count, pass_count,
          first_seen, last_seen, last_checked_at, last_passed_at, service_status)
       VALUES ('s1','192.0.2.10',8080,'http','fixture','active',88,150,4,3,?,?,?,?,'passed'),
              ('s2','192.0.2.11',1080,'socks5','fixture','active',70,900,5,4,?,?,?,?,'passed'),
              ('s3','192.0.2.12',1080,'socks5','fixture','quarantined',10,NULL,9,1,?,?,?,NULL,'failed')`,
      [NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW],
    );

    const stats = await proxies.stats({
      ttlMinutes: 90,
      service: 'crunchyroll',
      requireServicePass: true,
      nowIso: NOW,
    });
    expect(stats.pool_size).toBe(2);
    expect(stats.quarantined).toBe(1);
    expect(stats.by_protocol).toEqual({ http: 1, https: 0, socks4: 0, socks5: 1 });
    expect(stats.avg_latency_ms).toBe(525);
    expect(stats.min_latency_ms).toBe(150);
    expect(stats.max_latency_ms).toBe(900);
    expect(stats.p95_latency_ms).toBe(900);
    expect(stats.service_passed).toBe(2);
    expect(stats.avg_score).toBe(79);
    expect(stats.last_update).toBe(NOW);
    expect(Number(stats.pass_rate)).toBeGreaterThan(0);
  });

  it('prunes history', async () => {
    const old = new Date(nowMs - 40 * 86_400_000).toISOString();
    await db.run(`UPDATE validation_results SET created_at = ?`, [old]);
    const result = await proxies.pruneHistory({
      resultRetentionDays: 7,
      deadProxyRetentionDays: 7,
      cycleRetentionDays: 7,
      nowIso: NOW,
    });
    expect(result.validation_results).toBeGreaterThan(0);
  });
});

describe('database file handling', () => {
  it('creates the parent directory of a file: database instead of failing with SQLITE_CANTOPEN', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proxypulse-dbdir-'));
    const url = `file:${join(root, 'data', 'nested', 'pool.db')}`;
    try {
      const handle = createDb({ url });
      const applied = await applyMigrations(handle, { dir: findMigrationsDir() });
      expect(applied.applied.length).toBeGreaterThan(0);
      await handle.run('INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)', [
        META_KEYS.lastPruneAt,
        '2026-09-14T10:00:00.000Z',
        NOW,
      ]);
      expect(
        (
          await handle.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
            META_KEYS.lastPruneAt,
          ])
        )?.value,
      ).toBe('2026-09-14T10:00:00.000Z');
      handle.close();
      expect(existsSync(join(root, 'data', 'nested', 'pool.db'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
