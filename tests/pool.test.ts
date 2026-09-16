/**
 * Rolling pool semantics: status transitions, score composition, expiry, capacity and the reads the
 * public API is allowed to make. A small fixture set (twelve proxies) stands in for a real pool —
 * the rules are the same whether there are twelve rows or twelve million.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  createDb,
  findMigrationsDir,
  ProxiesRepository,
  type DbHandle,
  type ProxyRow,
  type CandidateInput,
} from '@proxypulse/db';
import { createLogger, type PublicProxy } from '@proxypulse/shared';
import { PoolManager, type ValidatedOutcome } from '../worker/src/pool/manager';
import type { ValidationOutcome } from '../worker/src/validation/checker';
import { loadConfig, type WorkerConfig } from '../worker/src/config';

const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();

let db: DbHandle;
let proxies: ProxiesRepository;
let config: WorkerConfig;
let pool: PoolManager;
const logger = createLogger({ name: 'pool-test', level: 'error' });

const outcome = (row: ProxyRow, overrides: Partial<ValidationOutcome> = {}): ValidatedOutcome => ({
  proxy_id: row.id,
  outcome: {
    proxy: { host: row.host, port: row.port, protocol: row.protocol },
    reachable: true,
    latency_ms: 120,
    http_status: 204,
    error_code: null,
    error_message: null,
    attempts: 1,
    duration_ms: 130,
    transport: 'absolute-form',
    egress: 'public',
    ...overrides,
  },
});

const mkCandidate = (index: number, host = `203.0.113.${index}`): CandidateInput => ({
  proxy: {
    host,
    port: 8080 + index,
    protocol: index % 2 === 0 ? 'socks5' : 'http',
    anonymity: 'unknown',
  },
  source: 'fixture-source',
});

const rowsByHost = async (): Promise<Map<string, ProxyRow>> => {
  const all = await proxies.listByStatus('new', 100);
  const active = await proxies.listByStatus('active', 100);
  const map = new Map<string, ProxyRow>();
  for (const row of [...all, ...active]) map.set(row.host, row);
  return map;
};

beforeAll(async () => {
  db = createDb({ url: ':memory:' });
  await applyMigrations(db, { dir: findMigrationsDir() });
  proxies = new ProxiesRepository(db);
  config = loadConfig({
    env: {
      ENVIRONMENT: 'test',
      DATABASE_URL: 'file:./pool-test.db',
      POOL_MIN_SCORE: '25',
      POOL_TTL_MINUTES: '90',
      POOL_MAX_CONSECUTIVE_FAILURES: '3',
      POOL_MAX_ACTIVE: '50',
      VALIDATION_MAX_PER_CYCLE: '500',
    },
  });
  pool = new PoolManager({ proxies, config, logger });
});

beforeEach(async () => {
  await db.run('DELETE FROM proxies');
  await db.run('DELETE FROM validation_results');
  await db.run('DELETE FROM service_results');
  await db.run('DELETE FROM refresh_cycles');
});

describe('planValidation', () => {
  it('promises nothing it cannot keep: a reachable proxy becomes active and is scored', async () => {
    await proxies.upsertCandidates([mkCandidate(1)], 'cyc_a', NOW_ISO);
    const row = (await rowsByHost()).get('203.0.113.1');
    expect(row).toBeDefined();
    const plan = pool.planValidation([row!], [outcome(row!, { latency_ms: 95 })], {
      cycleId: 'cyc_a',
      nowMs: NOW,
      trustByDedupeKey: new Map(),
    });
    expect(plan.tally).toMatchObject({
      checked: 1,
      passed: 1,
      failed: 0,
      added: 1,
      retained: 0,
      quarantined: 0,
    });
    const update = plan.updates[0]!;
    expect(update.status).toBe('active');
    expect(update.score).toBeGreaterThan(config.pool.minScore);
    expect(update.validation_status).toBe('passed');
    expect(update.consecutive_failures).toBe(0);
    await proxies.persistValidationOutcomes(plan.updates);
    const stored = await db.get<ProxyRow>('SELECT * FROM proxies WHERE id = ?', [row!.id]);
    expect(stored?.status).toBe('active');
    expect(stored?.last_passed_at).toBe(NOW_ISO);
  });

  it('quarantines a passing proxy that scores below the pool floor', async () => {
    await proxies.upsertCandidates([mkCandidate(2)], 'cyc_a', NOW_ISO);
    const row = (await rowsByHost()).get('203.0.113.2')!;
    const strict = new PoolManager({
      proxies,
      logger,
      config: { ...config, pool: { ...config.pool, minScore: 99 } },
    });
    const plan = strict.planValidation([row], [outcome(row, { latency_ms: 4_000 })], {
      cycleId: 'cyc_a',
      nowMs: NOW,
      trustByDedupeKey: new Map(),
    });
    expect(plan.updates[0]?.status).toBe('quarantined');
    expect(plan.updates[0]?.notes).toMatch(/^low_score:/);
    expect(plan.tally.quarantined).toBe(1);
  });

  it('keeps a first-time failure in the backlog instead of deleting it', async () => {
    await proxies.upsertCandidates([mkCandidate(3)], 'cyc_a', NOW_ISO);
    const row = (await rowsByHost()).get('203.0.113.3')!;
    const plan = pool.planValidation(
      [row],
      [outcome(row, { reachable: false, latency_ms: null, error_code: 'timeout' })],
      {
        cycleId: 'cyc_a',
        nowMs: NOW,
        trustByDedupeKey: new Map(),
      },
    );
    expect(plan.updates[0]?.status).toBe('new');
    expect(plan.updates[0]?.consecutive_failures).toBe(1);
    expect(plan.updates[0]?.score).toBe(0);
  });

  it('quarantines at the failure threshold and marks hopeless rows dead', async () => {
    await proxies.upsertCandidates([mkCandidate(4), mkCandidate(5)], 'cyc_a', NOW_ISO);
    const rows = await rowsByHost();
    const soon = rows.get('203.0.113.4')!;
    const hopeless = rows.get('203.0.113.5')!;
    await db.run('UPDATE proxies SET consecutive_failures = 2 WHERE id = ?', [soon.id]);
    await db.run(
      'UPDATE proxies SET consecutive_failures = 9, last_passed_at = NULL WHERE id = ?',
      [hopeless.id],
    );
    const refreshed = await db.all<ProxyRow>('SELECT * FROM proxies ORDER BY id');
    const plan = pool.planValidation(
      refreshed,
      refreshed.map((row) =>
        outcome(row, { reachable: false, latency_ms: null, error_code: 'connect_refused' }),
      ),
      { cycleId: 'cyc_a', nowMs: NOW, trustByDedupeKey: new Map() },
    );
    const byId = new Map(plan.updates.map((update) => [update.id, update]));
    expect(byId.get(soon.id)?.status).toBe('quarantined');
    expect(byId.get(soon.id)?.notes).toBe('failures:3');
    expect(byId.get(hopeless.id)?.status).toBe('dead');
    expect(byId.get(hopeless.id)?.notes).toBe('unrecoverable');
  });

  it('gives an active member one free miss before reacting', async () => {
    await proxies.upsertCandidates([mkCandidate(6)], 'cyc_a', NOW_ISO);
    const row = (await rowsByHost()).get('203.0.113.6')!;
    await db.run(
      "UPDATE proxies SET status = 'active', last_passed_at = ?, check_count = 8, pass_count = 8 WHERE id = ?",
      [new Date(NOW - 60_000).toISOString(), row.id],
    );
    const stored = await db.get<ProxyRow>('SELECT * FROM proxies WHERE id = ?', [row.id]);
    const plan = pool.planValidation(
      [stored!],
      [outcome(stored!, { reachable: false, latency_ms: null, error_code: 'timeout' })],
      {
        cycleId: 'cyc_a',
        nowMs: NOW,
        trustByDedupeKey: new Map(),
      },
    );
    expect(plan.updates[0]?.status).toBe('active');
    expect(plan.updates[0]?.notes).toBe('transient_failure:1');
    expect(plan.tally.retained).toBe(1);
  });

  it('lets a source trust rating move the score, and never trusts an unknown source', async () => {
    await proxies.upsertCandidates([mkCandidate(7), mkCandidate(8)], 'cyc_a', NOW_ISO);
    const rows = [...(await rowsByHost()).values()];
    const trust = new Map<string, number>();
    for (const row of rows) trust.set(row.dedupe_key, row.host.endsWith('.7') ? 1 : 0.05);
    const plan = pool.planValidation(
      rows,
      rows.map((row) => outcome(row)),
      { cycleId: 'cyc_a', nowMs: NOW, trustByDedupeKey: trust },
    );
    const scores = plan.updates.map((update) => update.score);
    expect(Math.max(...scores)).toBeGreaterThan(Math.min(...scores));
  });
});

describe('planService', () => {
  it('rewards a passing service probe and punishes a blocked one', async () => {
    await proxies.upsertCandidates([mkCandidate(9), mkCandidate(10)], 'cyc_a', NOW_ISO);
    await db.run(
      "UPDATE proxies SET status = 'active', validation_status = 'passed', score = 60, last_passed_at = ? WHERE 1",
      [NOW_ISO],
    );
    const stored = await db.all<ProxyRow>('SELECT * FROM proxies ORDER BY id');
    const results = [
      {
        proxy_id: stored[0]!.id,
        status: 'passed' as const,
        latency_ms: 210,
        http_status: 200,
        reason: null,
        details: null,
        quality: 0.95,
      },
      {
        proxy_id: stored[1]!.id,
        status: 'blocked' as const,
        latency_ms: null,
        http_status: 403,
        reason: 'denied:403',
        details: null,
        quality: 0.05,
      },
    ];
    const planned = pool.planService(stored, results, { cycleId: 'cyc_a', nowMs: NOW });
    expect(planned[0]?.status).toBe('passed');
    expect(planned[0]?.score).toBeGreaterThan(60);
    expect(planned[1]?.status).toBe('blocked');
    expect(planned[1]?.score).toBeLessThan(60);
    expect(planned[1]?.reason).toBe('denied:403');
    await proxies.persistServiceOutcomes('crunchyroll', planned);
    const reread = await db.get<{ service_status: string; score: number }>(
      'SELECT service_status, score FROM proxies WHERE id = ?',
      [stored[1]!.id],
    );
    expect(reread?.service_status).toBe('blocked');
  });

  it('leaves the connectivity score alone when there is no verdict', async () => {
    await proxies.upsertCandidates([mkCandidate(11)], 'cyc_a', NOW_ISO);
    const row = (await rowsByHost()).get('203.0.113.11')!;
    await db.run(
      "UPDATE proxies SET status = 'active', validation_status = 'passed', score = 71 WHERE id = ?",
      [row.id],
    );
    const stored = await db.get<ProxyRow>('SELECT * FROM proxies WHERE id = ?', [row.id]);
    const planned = pool.planService([stored!], [], { cycleId: 'cyc_a', nowMs: NOW });
    expect(planned).toHaveLength(0);
  });
});

describe('finalize (the rolling part of the rolling pool)', () => {
  it('expires stale members, quarantines repeated failures and honours the capacity cap', async () => {
    const candidates = Array.from({ length: 6 }, (_, index) => mkCandidate(index + 1));
    await proxies.upsertCandidates(candidates, 'cyc_a', NOW_ISO);
    await db.run(
      "UPDATE proxies SET status = 'active', validation_status = 'passed', score = 80, last_passed_at = ?",
      [NOW_ISO],
    );
    // one member went quiet beyond the TTL
    await db.run("UPDATE proxies SET last_passed_at = ? WHERE host = '203.0.113.1'", [
      new Date(NOW - 3 * 60 * 60_000).toISOString(),
    ]);
    // one member is failing repeatedly
    await db.run('UPDATE proxies SET consecutive_failures = 4 WHERE host = ?', ['203.0.113.2']);
    // one member is stuck in pending from an abandoned cycle, one was claimed by this cycle
    await db.run(
      "UPDATE proxies SET status = 'pending', last_cycle_id = 'cyc_old' WHERE host = ?",
      ['203.0.113.3'],
    );
    await db.run(
      "UPDATE proxies SET status = 'pending', last_cycle_id = 'cyc_new' WHERE host = ?",
      ['203.0.113.4'],
    );

    const result = await pool.finalize({ cycleId: 'cyc_new', nowMs: NOW });
    expect(result.expired).toBe(1);
    expect(result.quarantined).toBe(1);
    expect(result.released).toBe(2);
    // .1 expired, .2 quarantined, .3/.4 back to the backlog: only .5 and .6 remain in the pool
    expect(result.pool_size).toBe(2);

    const statuses = await db.all<{ host: string; status: string; notes: string | null }>(
      'SELECT host, status, notes FROM proxies ORDER BY host',
    );
    const byHost = new Map(statuses.map((row) => [row.host, row]));
    expect(byHost.get('203.0.113.1')?.status).toBe('dead');
    expect(byHost.get('203.0.113.1')?.notes).toContain('expired');
    expect(byHost.get('203.0.113.2')?.status).toBe('quarantined');
    expect(byHost.get('203.0.113.3')?.status).toBe('new');
    expect(byHost.get('203.0.113.4')?.status).toBe('new');
    // the healthy remainder is untouched: no blanket delete
    expect(byHost.get('203.0.113.6')?.status).toBe('active');
    expect((await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM proxies'))?.count).toBe(
      6,
    );
  });

  it('demotes the lowest scored members when the pool is over capacity', async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => mkCandidate(index + 1));
    await proxies.upsertCandidates(candidates, 'cyc_a', NOW_ISO);
    await db.run(
      "UPDATE proxies SET status = 'active', validation_status = 'passed', last_passed_at = ?",
      [NOW_ISO],
    );
    await db.run('UPDATE proxies SET score = 10 + id');
    const bounded = new PoolManager({
      proxies,
      logger,
      config: { ...config, pool: { ...config.pool, maxActive: 2 } },
    });
    const result = await bounded.finalize({ cycleId: 'cyc_b', nowMs: NOW });
    expect(result.demoted).toBe(3);
    expect(result.pool_size).toBe(2);
    const kept = await db.all<{ score: number }>(
      "SELECT score FROM proxies WHERE status = 'active' ORDER BY score DESC",
    );
    expect(kept.map((row) => row.score)).toEqual([15, 14]);
  });
});

describe('readPool (what the public API may see)', () => {
  const seed = async (): Promise<void> => {
    await proxies.upsertCandidates(
      [
        {
          proxy: {
            host: '198.51.100.1',
            port: 80,
            protocol: 'http',
            username: 'u1',
            password: 'p1',
          },
          source: 's',
        },
        { proxy: { host: '198.51.100.2', port: 1080, protocol: 'socks5' }, source: 's' },
        { proxy: { host: '198.51.100.3', port: 8080, protocol: 'http' }, source: 's' },
        { proxy: { host: '198.51.100.4', port: 3128, protocol: 'https' }, source: 's' },
      ],
      'cyc_a',
      NOW_ISO,
    );
    await db.run(
      "UPDATE proxies SET status = 'active', validation_status = 'passed', last_passed_at = ?, service_status = 'passed', country = 'US' WHERE 1",
      [NOW_ISO],
    );
    await db.run("UPDATE proxies SET score = 30, latency_ms = 100 WHERE host = '198.51.100.1'");
    await db.run("UPDATE proxies SET score = 40, latency_ms = 200 WHERE host = '198.51.100.2'");
    await db.run("UPDATE proxies SET score = 50, latency_ms = 300 WHERE host = '198.51.100.3'");
    await db.run(
      "UPDATE proxies SET score = 90, latency_ms = 400, service_status = 'untested', country = 'DE' WHERE host = '198.51.100.4'",
    );
    // one healthy member is dead weight, one is quarantined: neither may surface in the pool
    await db.run("UPDATE proxies SET status = 'dead' WHERE host = '198.51.100.3'");
    await db.run(
      "UPDATE proxies SET status = 'quarantined', country = 'US' WHERE host = '198.51.100.1'",
    );
  };

  it('returns only fresh, active, above-floor entries and never credentials', async () => {
    await seed();
    const read = await proxies.readPool({
      limit: 10,
      offset: 0,
      protocol: null,
      minScore: 25,
      maxLatencyMs: null,
      country: null,
      service: 'off',
      ttlMinutes: 90,
      nowIso: NOW_ISO,
    });
    expect(read.total).toBe(2);
    // quarantined and dead rows are never returned, newest-best first
    expect(read.entries.map((entry) => entry.host)).toEqual(['198.51.100.4', '198.51.100.2']);
    for (const entry of read.entries as unknown as Record<string, unknown>[]) {
      expect(entry).not.toHaveProperty('username');
      expect(entry).not.toHaveProperty('password');
      expect(entry).not.toHaveProperty('dedupe_key');
      expect(entry).toHaveProperty('last_passed');
    }
    expect(JSON.stringify(read)).not.toContain('p1');
  });

  it('filters by protocol, latency and country, and can require a service pass', async () => {
    await seed();
    const socks = await proxies.readPool({
      limit: 10,
      offset: 0,
      protocol: 'socks5',
      minScore: 0,
      maxLatencyMs: null,
      country: null,
      service: 'off',
      ttlMinutes: 90,
      nowIso: NOW_ISO,
    });
    expect(socks.entries.map((entry) => entry.port)).toEqual([1080]);

    const fast = await proxies.readPool({
      limit: 10,
      offset: 0,
      protocol: null,
      minScore: 0,
      maxLatencyMs: 250,
      country: 'us',
      service: 'off',
      ttlMinutes: 90,
      nowIso: NOW_ISO,
    });
    expect(fast.entries.map((entry: PublicProxy) => entry.host)).toEqual(['198.51.100.2']);

    const strict = await proxies.readPool({
      limit: 10,
      offset: 0,
      protocol: null,
      minScore: 0,
      maxLatencyMs: null,
      country: null,
      service: 'required',
      ttlMinutes: 90,
      nowIso: NOW_ISO,
    });
    expect(strict.entries.map((entry) => entry.host)).toEqual(['198.51.100.2']);

    const preferred = await proxies.readPool({
      limit: 10,
      offset: 0,
      protocol: null,
      minScore: 0,
      maxLatencyMs: null,
      country: null,
      service: 'preferred',
      ttlMinutes: 90,
      nowIso: NOW_ISO,
    });
    expect(preferred.entries[0]?.host).toBe('198.51.100.2');
  });

  it('pages with limit/offset while reporting the unfiltered total', async () => {
    await seed();
    const first = await proxies.readPool({
      limit: 1,
      offset: 0,
      protocol: null,
      minScore: 0,
      maxLatencyMs: null,
      country: null,
      service: 'off',
      ttlMinutes: 90,
      nowIso: NOW_ISO,
    });
    const second = await proxies.readPool({
      limit: 1,
      offset: 1,
      protocol: null,
      minScore: 0,
      maxLatencyMs: null,
      country: null,
      service: 'off',
      ttlMinutes: 90,
      nowIso: NOW_ISO,
    });
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(first.entries[0]?.host).not.toBe(second.entries[0]?.host);
  });

  it('excludes entries whose last success is older than the TTL', async () => {
    await seed();
    await db.run('UPDATE proxies SET last_passed_at = ? WHERE id = 2', [
      new Date(NOW - 120 * 60_000).toISOString(),
    ]);
    const read = await proxies.readPool({
      limit: 10,
      offset: 0,
      protocol: null,
      minScore: 0,
      maxLatencyMs: null,
      country: null,
      service: 'off',
      ttlMinutes: 90,
      nowIso: NOW_ISO,
    });
    expect(read.entries.map((entry) => entry.host)).toEqual(['198.51.100.4']);
  });
});

describe('validation queue selection', () => {
  it('separates fresh candidates, quarantine reviews and due rechecks', async () => {
    const candidates = Array.from({ length: 8 }, (_, index) => mkCandidate(index + 1));
    await proxies.upsertCandidates(candidates, 'cyc_a', NOW_ISO);
    await db.run(
      "UPDATE proxies SET status = 'active', validation_status = 'passed', last_passed_at = ?, last_checked_at = ? WHERE id <= 3",
      [NOW_ISO, new Date(NOW - 60 * 60_000).toISOString()],
    );
    await db.run(
      "UPDATE proxies SET status = 'quarantined', consecutive_failures = 3 WHERE id IN (4, 5)",
      [],
    );

    const queue = await proxies.selectValidationQueue({
      newLimit: 2,
      quarantineLimit: 1,
      recheckLimit: 2,
      recheckAfterMinutes: 30,
      nowIso: NOW_ISO,
    });
    expect(queue).toHaveLength(5);
    const statuses = queue.map((row) => row.status);
    expect(statuses.filter((status) => status === 'new')).toHaveLength(2);
    expect(statuses.filter((status) => status === 'quarantined')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'active')).toHaveLength(2);

    // recently checked members are not re-checked on every cycle
    await db.run("UPDATE proxies SET last_checked_at = ? WHERE status = 'active'", [
      new Date(NOW - 60_000).toISOString(),
    ]);
    const again = await proxies.selectValidationQueue({
      newLimit: 10,
      quarantineLimit: 10,
      recheckLimit: 10,
      recheckAfterMinutes: 30,
      nowIso: NOW_ISO,
    });
    expect(again.filter((row) => row.status === 'active')).toHaveLength(0);
  });

  it('marks rows pending for a cycle and releases them again if the cycle dies', async () => {
    await proxies.upsertCandidates([mkCandidate(1), mkCandidate(2)], 'cyc_a', NOW_ISO);
    const rows = await db.all<ProxyRow>('SELECT * FROM proxies ORDER BY id');
    await proxies.markPending(
      rows.map((row) => row.id),
      'cyc_a',
    );
    expect(
      (
        await db.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM proxies WHERE status = 'pending'",
        )
      )?.count,
    ).toBe(2);
    // a crash: the cycle never completed, so the rows must not stay stuck
    expect(await proxies.releaseOrphanedPending('cyc_other')).toBe(0);
    expect(await proxies.releaseForeignPending('cyc_other')).toBe(2);
    expect(
      (
        await db.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM proxies WHERE status = 'new'",
        )
      )?.count,
    ).toBe(2);
    // a claim owned by the running cycle is left alone by the foreign sweep
    await proxies.markPending([rows[0]!.id], 'cyc_b');
    expect(await proxies.releaseForeignPending('cyc_b')).toBe(0);
    expect(await proxies.releaseOrphanedPending('cyc_b')).toBe(1);
  });
});
