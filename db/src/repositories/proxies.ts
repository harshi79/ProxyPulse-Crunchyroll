/**
 * Proxy repository: discovery upserts, validation queue selection, outcome persistence, pool
 * maintenance and pool reads. All statements are parameterized; all list reads are bounded.
 */

import {
  dedupeKeyHash,
  type AnonymityLevel,
  type PoolStats,
  type PublicProxy,
  type ProxyProtocol,
  type ProxyStatus,
  type ServiceStatus,
  type ValidationStatus,
  PROXY_PROTOCOLS,
} from '@proxypulse/shared';

import { type InStatement } from '@libsql/client';

import { type DbHandle } from '../client.js';
import { type PoolStatusCounts, type ProxyRow } from '../types.js';

const PROXY_COLUMNS = `id, dedupe_key, host, port, protocol, username, password, source, status,
  validation_status, service_status, score, latency_ms, service_latency_ms, service_checked_at, service_fail_reason,
  last_error_code, country, anonymity, first_seen, last_seen, first_cycle_id, last_cycle_id,
  last_checked_at, last_passed_at, consecutive_failures, check_count, pass_count, notes`;

/** Columns that are safe to hand to the public API (no credentials, no internal bookkeeping). */
const PUBLIC_COLUMNS = `id, host, port, protocol, source, score, latency_ms, country, anonymity, last_passed_at`;

const UPSERT_CHUNK = 400;
const WRITE_CHUNK = 200;

export interface CandidateInput {
  proxy: {
    host: string;
    port: number;
    protocol: ProxyProtocol;
    username?: string | undefined;
    password?: string | undefined;
    country?: string | undefined;
    anonymity?: AnonymityLevel | undefined;
  };
  source: string;
}

export interface UpsertResult {
  total: number;
  inserted: number;
  touched: number;
}

export interface ValidationOutcome {
  id: number;
  cycle_id: string;
  created_at: string;
  reachable: boolean;
  latency_ms: number | null;
  protocol: ProxyProtocol;
  transport: string | null;
  http_status: number | null;
  error_code: string | null;
  /** Already redacted by the caller. */
  error_message: string | null;
  attempts: number;
  duration_ms: number;
  status: ProxyStatus;
  validation_status: ValidationStatus;
  consecutive_failures: number;
  score: number;
  service_status: ServiceStatus;
  /** Short machine readable pool note (e.g. `low_score:12`); never contains secrets. */
  notes?: string | null;
}

export interface ServiceOutcome {
  id: number;
  cycle_id: string;
  service: string;
  created_at: string;
  passed: boolean;
  status: ServiceStatus;
  http_status: number | null;
  latency_ms: number | null;
  reason: string | null;
  details: string | null;
  score: number;
  status_next: ProxyStatus;
}

export interface PoolReadQuery {
  limit: number;
  offset: number;
  protocol: ProxyProtocol | null;
  minScore: number;
  maxLatencyMs: number | null;
  country: string | null;
  service: 'required' | 'preferred' | 'off';
  /** Only entries with a successful check inside this window are considered alive. */
  ttlMinutes: number;
  nowIso: string;
}

export interface PoolReadResult {
  entries: PublicProxy[];
  total: number;
}

const isoAgo = (iso: string, minutes: number): string =>
  new Date(Date.parse(iso) - minutes * 60_000).toISOString();

export class ProxiesRepository {
  constructor(private readonly db: DbHandle) {}

  /**
   * Inserts newly discovered proxies and refreshes `last_seen` for known ones. Existing rows keep
   * their status/score (a proxy that is already in the pool is not reset by re-discovery), except
   * that `dead` rows seen again are revived as `new` so they get re-validated.
   */
  async upsertCandidates(
    candidates: readonly CandidateInput[],
    cycleId: string,
    nowIso: string = new Date().toISOString(),
  ): Promise<UpsertResult> {
    const unique = new Map<string, CandidateInput>();
    for (const candidate of candidates) {
      const key = dedupeKeyHash(candidate.proxy);
      if (!unique.has(key)) unique.set(key, candidate);
    }
    const keys = [...unique.keys()];
    if (keys.length === 0) return { total: 0, inserted: 0, touched: 0 };

    let inserted = 0;
    for (let start = 0; start < keys.length; start += UPSERT_CHUNK) {
      const chunk = keys.slice(start, start + UPSERT_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const existing = await this.db.all<{ dedupe_key: string }>(
        `SELECT dedupe_key FROM proxies WHERE dedupe_key IN (${placeholders})`,
        chunk,
      );
      inserted += chunk.length - existing.length;
    }

    const statements: InStatement[] = [];
    for (const [key, candidate] of unique) {
      const proxy = candidate.proxy;
      statements.push({
        sql: `INSERT INTO proxies (dedupe_key, host, port, protocol, username, password, source, status,
            first_seen, last_seen, first_cycle_id, last_cycle_id, country, anonymity)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)
          ON CONFLICT (dedupe_key) DO UPDATE SET
            last_seen = excluded.last_seen,
            last_cycle_id = excluded.last_cycle_id,
            country = COALESCE(proxies.country, excluded.country),
            username = COALESCE(proxies.username, excluded.username),
            password = COALESCE(proxies.password, excluded.password),
            status = CASE WHEN proxies.status = 'dead' THEN 'new' ELSE proxies.status END`,
        args: [
          key,
          proxy.host,
          proxy.port,
          proxy.protocol,
          proxy.username ?? null,
          proxy.password ?? null,
          candidate.source,
          nowIso,
          nowIso,
          cycleId,
          cycleId,
          proxy.country ?? null,
          proxy.anonymity ?? 'unknown',
        ],
      });
    }

    for (let start = 0; start < statements.length; start += WRITE_CHUNK) {
      await this.db.batch(statements.slice(start, start + WRITE_CHUNK));
    }

    return { total: unique.size, inserted, touched: unique.size - inserted };
  }

  async listExistingDedupeKeys(keys: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (let start = 0; start < keys.length; start += UPSERT_CHUNK) {
      const chunk = keys.slice(start, start + UPSERT_CHUNK);
      const rows = await this.db.all<{ dedupe_key: string }>(
        `SELECT dedupe_key FROM proxies WHERE dedupe_key IN (${chunk.map(() => '?').join(', ')})`,
        chunk,
      );
      for (const row of rows) out.add(row.dedupe_key);
    }
    return out;
  }

  /**
   * Selects the work for one cycle: never-validated `new` rows first, then quarantined rows that
   * deserve a revival attempt, then pool members whose last check is older than the recheck window.
   */
  async selectValidationQueue(options: {
    newLimit: number;
    quarantineLimit: number;
    recheckLimit: number;
    recheckAfterMinutes: number;
    nowIso?: string;
  }): Promise<ProxyRow[]> {
    const nowIso = options.nowIso ?? new Date().toISOString();
    const recheckBefore = isoAgo(nowIso, options.recheckAfterMinutes);

    const [fresh, quarantined, staleActive] = await Promise.all([
      options.newLimit > 0
        ? this.db.all<ProxyRow>(
            `SELECT ${PROXY_COLUMNS} FROM proxies WHERE status = 'new' ORDER BY id ASC LIMIT ?`,
            [options.newLimit],
          )
        : Promise.resolve([] as ProxyRow[]),
      options.quarantineLimit > 0
        ? this.db.all<ProxyRow>(
            `SELECT ${PROXY_COLUMNS} FROM proxies WHERE status = 'quarantined'
             ORDER BY last_checked_at IS NULL DESC, last_checked_at ASC LIMIT ?`,
            [options.quarantineLimit],
          )
        : Promise.resolve([] as ProxyRow[]),
      options.recheckLimit > 0
        ? this.db.all<ProxyRow>(
            `SELECT ${PROXY_COLUMNS} FROM proxies
             WHERE status = 'active' AND (last_checked_at IS NULL OR last_checked_at < ?)
             ORDER BY last_checked_at ASC LIMIT ?`,
            [recheckBefore, options.recheckLimit],
          )
        : Promise.resolve([] as ProxyRow[]),
    ]);

    const seen = new Set<number>();
    const merged: ProxyRow[] = [];
    for (const row of [...fresh, ...quarantined, ...staleActive]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
    return merged;
  }

  /** Claims rows for this cycle: a crash mid-cycle leaves them recoverable instead of stuck. */
  async markPending(ids: readonly number[], cycleId: string): Promise<void> {
    for (const chunk of chunked(ids, WRITE_CHUNK)) {
      await this.db.run(
        `UPDATE proxies SET status = 'pending', last_cycle_id = ?
          WHERE id IN (${chunk.map(() => '?').join(', ')}) AND status IN ('new', 'quarantined', 'active')`,
        [cycleId, ...chunk],
      );
    }
  }

  /** Any row still pending at the end of a cycle never got a result: send it back to `new`. */
  async releaseOrphanedPending(cycleId: string): Promise<number> {
    const result = await this.db.run(
      `UPDATE proxies SET status = 'new' WHERE status = 'pending' AND last_cycle_id = ?`,
      [cycleId],
    );
    return result.rowsAffected;
  }

  /**
   * Stranded claims: `pending` rows that belong to a *different* cycle can only be left over from an
   * abandoned run, so they go back to the backlog instead of rotting. Safe because exactly one writer
   * runs the refresh cycle (see ARCHITECTURE.md); with several workers, disable this via the caller.
   */
  async releaseForeignPending(cycleId: string): Promise<number> {
    const result = await this.db.run(
      `UPDATE proxies SET status = 'new'
         WHERE status = 'pending' AND (last_cycle_id IS NULL OR last_cycle_id != ?)`,
      [cycleId],
    );
    return result.rowsAffected;
  }

  async getByIds(ids: readonly number[]): Promise<ProxyRow[]> {
    if (ids.length === 0) return [];
    const rows: ProxyRow[] = [];
    for (const chunk of chunked(ids, UPSERT_CHUNK)) {
      rows.push(
        ...(await this.db.all<ProxyRow>(
          `SELECT ${PROXY_COLUMNS} FROM proxies WHERE id IN (${chunk.map(() => '?').join(', ')})`,
          chunk,
        )),
      );
    }
    return rows;
  }

  async listByStatus(status: ProxyStatus, limit: number, offset = 0): Promise<ProxyRow[]> {
    return this.db.all<ProxyRow>(
      `SELECT ${PROXY_COLUMNS} FROM proxies WHERE status = ? ORDER BY score DESC, id ASC LIMIT ? OFFSET ?`,
      [status, limit, offset],
    );
  }

  /** Writes connectivity results and the resulting pool state in one atomic batch per chunk. */
  async persistValidationOutcomes(outcomes: readonly ValidationOutcome[]): Promise<void> {
    const statements: InStatement[] = [];
    for (const outcome of outcomes) {
      statements.push({
        sql: `INSERT INTO validation_results (proxy_id, cycle_id, created_at, reachable, latency_ms, protocol,
            transport, http_status, error_code, error_message, attempts, duration_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          outcome.id,
          outcome.cycle_id,
          outcome.created_at,
          outcome.reachable ? 1 : 0,
          outcome.latency_ms,
          outcome.protocol,
          outcome.transport,
          outcome.http_status,
          outcome.error_code,
          outcome.error_message,
          outcome.attempts,
          outcome.duration_ms,
        ],
      });
      statements.push({
        sql: `UPDATE proxies SET
            status = ?,
            validation_status = ?,
            latency_ms = ?,
            last_checked_at = ?,
            last_passed_at = CASE WHEN ? = 1 THEN ? ELSE last_passed_at END,
            consecutive_failures = ?,
            check_count = check_count + 1,
            pass_count = pass_count + ?,
            score = ?,
            service_status = ?,
            last_error_code = ?,
            notes = COALESCE(?, notes)
          WHERE id = ?`,
        args: [
          outcome.status,
          outcome.validation_status,
          outcome.latency_ms,
          outcome.created_at,
          outcome.reachable ? 1 : 0,
          outcome.created_at,
          outcome.consecutive_failures,
          outcome.reachable ? 1 : 0,
          outcome.score,
          outcome.service_status,
          outcome.error_code,
          outcome.notes ?? null,
          outcome.id,
        ],
      });
    }
    for (const chunk of chunked(statements, WRITE_CHUNK * 2)) {
      await this.db.batch(chunk);
    }
  }

  async persistServiceOutcomes(
    service: string,
    outcomes: readonly ServiceOutcome[],
  ): Promise<void> {
    const statements: InStatement[] = [];
    for (const outcome of outcomes) {
      statements.push({
        sql: `INSERT INTO service_results (proxy_id, cycle_id, service, created_at, passed, status,
            http_status, latency_ms, reason, details)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          outcome.id,
          outcome.cycle_id,
          service,
          outcome.created_at,
          outcome.passed ? 1 : 0,
          outcome.status,
          outcome.http_status,
          outcome.latency_ms,
          outcome.reason,
          outcome.details,
        ],
      });
      statements.push({
        sql: `UPDATE proxies SET service_status = ?, service_latency_ms = ?, service_checked_at = ?,
                service_fail_reason = ?, score = ?, status = ?
          WHERE id = ?`,
        args: [
          outcome.status,
          outcome.latency_ms,
          outcome.created_at,
          outcome.reason,
          outcome.score,
          outcome.status_next,
          outcome.id,
        ],
      });
    }
    for (const chunk of chunked(statements, WRITE_CHUNK * 2)) {
      await this.db.batch(chunk);
    }
  }

  /** Pool expiry: healthy proxies that have not passed recently leave the public pool. */
  async expireStale(options: { ttlMinutes: number; nowIso?: string }): Promise<number> {
    const nowIso = options.nowIso ?? new Date().toISOString();
    const cutoff = isoAgo(nowIso, options.ttlMinutes);
    const result = await this.db.run(
      `UPDATE proxies SET status = 'dead', validation_status = 'failed', last_error_code = 'expired',
          notes = 'expired: no successful check within TTL'
        WHERE status = 'active' AND (last_passed_at IS NULL OR last_passed_at < ?)`,
      [cutoff],
    );
    return result.rowsAffected;
  }

  /** Quarantine: repeated failures or a failed validation on a pool member. */
  async quarantineFailures(options: { maxConsecutiveFailures: number }): Promise<number> {
    const result = await this.db.run(
      `UPDATE proxies SET status = 'quarantined', notes = 'quarantined: consecutive failures'
        WHERE status = 'active' AND consecutive_failures >= ?`,
      [options.maxConsecutiveFailures],
    );
    return result.rowsAffected;
  }

  /** Keeps the pool bounded by demoting the lowest scored members past the cap. */
  async enforcePoolCapacity(maxActive: number): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM proxies WHERE status = 'active'`,
    );
    const active = row?.count ?? 0;
    if (active <= maxActive) return 0;
    const overflow = active - maxActive;
    const result = await this.db.run(
      `UPDATE proxies SET status = 'quarantined', notes = 'quarantined: pool capacity'
        WHERE id IN (
          SELECT id FROM proxies WHERE status = 'active'
          ORDER BY score ASC, latency_ms IS NULL DESC, latency_ms DESC, id ASC
          LIMIT ?
        )`,
      [overflow],
    );
    return result.rowsAffected;
  }

  /** Pool read used by the public API. Filters mirror `parsePoolQuery` in shared. */
  async readPool(query: PoolReadQuery): Promise<PoolReadResult> {
    const where: string[] = [
      `status = 'active'`,
      `score >= ?`,
      `last_passed_at IS NOT NULL`,
      `last_passed_at >= ?`,
    ];
    const args: (string | number | null)[] = [
      query.minScore,
      isoAgo(query.nowIso, query.ttlMinutes),
    ];

    if (query.protocol) {
      where.push('protocol = ?');
      args.push(query.protocol);
    }
    if (query.country) {
      where.push('country = ?');
      args.push(query.country.toUpperCase());
    }
    if (query.maxLatencyMs !== null) {
      where.push('latency_ms IS NOT NULL', 'latency_ms <= ?');
      args.push(query.maxLatencyMs);
    }
    if (query.service === 'required') {
      where.push(`service_status = 'passed'`);
    }
    const whereSql = where.join(' AND ');

    const orderSql =
      query.service === 'preferred'
        ? `ORDER BY (service_status = 'passed') DESC, score DESC, latency_ms IS NULL, latency_ms ASC, id ASC`
        : `ORDER BY score DESC, latency_ms IS NULL, latency_ms ASC, id ASC`;

    const rows = await this.db.all<PublicProxyRow>(
      `SELECT ${PUBLIC_COLUMNS}, last_passed_at AS last_passed FROM proxies WHERE ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
      [...args, query.limit, query.offset],
    );
    const totalRow = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM proxies WHERE ${whereSql}`,
      args,
    );

    return {
      entries: rows.map((row) => ({
        id: row.id,
        host: row.host,
        port: row.port,
        protocol: row.protocol,
        source: row.source,
        score: Math.round(row.score * 100) / 100,
        latency_ms: row.latency_ms,
        country: row.country,
        anonymity: row.anonymity,
        last_passed: row.last_passed ?? null,
      })),
      total: totalRow?.count ?? 0,
    };
  }

  /** Pool members whose service verdict is stale — used for the rolling re-check. */
  async selectServiceCandidates(options: {
    ids?: readonly number[];
    limit: number;
    minScore: number;
    recheckAfterMinutes: number;
    nowIso?: string;
  }): Promise<ProxyRow[]> {
    const nowIso = options.nowIso ?? new Date().toISOString();
    const freshBefore = isoAgo(nowIso, options.recheckAfterMinutes);
    if (options.ids && options.ids.length > 0) {
      const ids = options.ids.slice(0, options.limit);
      return this.db.all<ProxyRow>(
        `SELECT ${PROXY_COLUMNS} FROM proxies WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY score DESC LIMIT ?`,
        [...ids, options.limit],
      );
    }
    return this.db.all<ProxyRow>(
      `SELECT ${PROXY_COLUMNS} FROM proxies
        WHERE status = 'active' AND score >= ?
          AND (service_checked_at IS NULL OR service_checked_at < ?)
        ORDER BY score DESC, latency_ms ASC
        LIMIT ?`,
      [options.minScore, freshBefore, options.limit],
    );
  }

  /** Number of pool members that still have a fresh service verdict for this cycle. */
  async countFreshServiceVerdicts(options: {
    recheckAfterMinutes: number;
    nowIso?: string;
  }): Promise<number> {
    const nowIso = options.nowIso ?? new Date().toISOString();
    const row = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM proxies
        WHERE status = 'active' AND service_status = 'passed' AND service_checked_at >= ?`,
      [isoAgo(nowIso, options.recheckAfterMinutes)],
    );
    return row?.count ?? 0;
  }

  async markServiceUntested(ids: readonly number[], reason: string): Promise<void> {
    if (ids.length === 0) return;
    for (const chunk of chunked(ids, WRITE_CHUNK)) {
      await this.db.run(
        `UPDATE proxies SET service_status = 'skipped', service_fail_reason = ? WHERE id IN (${chunk
          .map(() => '?')
          .join(', ')})`,
        [reason, ...chunk],
      );
    }
  }

  async countByStatus(): Promise<PoolStatusCounts> {
    const rows = await this.db.all<{ status: ProxyStatus; count: number }>(
      'SELECT status, COUNT(*) AS count FROM proxies GROUP BY status',
    );
    const counts: PoolStatusCounts = {
      active: 0,
      quarantined: 0,
      dead: 0,
      new: 0,
      pending: 0,
      total: 0,
    };
    for (const row of rows) {
      counts.total += row.count;
      if (row.status in counts) counts[row.status as keyof PoolStatusCounts] = row.count;
    }
    return counts;
  }

  async stats(options: {
    ttlMinutes: number;
    service: string;
    requireServicePass: boolean;
    nowIso?: string;
  }): Promise<PoolStats> {
    const nowIso = options.nowIso ?? new Date().toISOString();
    const poolWhere = `status = 'active' AND last_passed_at >= ?${options.requireServicePass ? ` AND service_status = 'passed'` : ''}`;
    const poolArgs = [isoAgo(nowIso, options.ttlMinutes)];

    const [statusCounts, latency, scoreRow, servicePassed, reliability, protocolRows, lastUpdate] =
      await Promise.all([
        this.countByStatus(),
        this.db.get<{ avg: number | null; min: number | null; max: number | null; count: number }>(
          `SELECT AVG(latency_ms) AS avg, MIN(latency_ms) AS min, MAX(latency_ms) AS max, COUNT(latency_ms) AS count
             FROM proxies WHERE ${poolWhere}`,
          poolArgs,
        ),
        this.db.get<{ avg_score: number | null }>(
          `SELECT AVG(score) AS avg_score FROM proxies WHERE ${poolWhere}`,
          poolArgs,
        ),
        this.db.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM proxies WHERE ${poolWhere} AND service_status = 'passed'`,
          poolArgs,
        ),
        this.db.get<{ checks: number | null; passes: number | null }>(
          `SELECT SUM(check_count) AS checks, SUM(pass_count) AS passes FROM proxies WHERE status IN ('active', 'quarantined')`,
        ),
        this.db.all<{ protocol: ProxyProtocol; count: number }>(
          `SELECT protocol, COUNT(*) AS count FROM proxies WHERE ${poolWhere} GROUP BY protocol`,
          poolArgs,
        ),
        this.db.get<{ last_checked_at: string | null; last_passed_at: string | null }>(
          `SELECT MAX(last_checked_at) AS last_checked_at, MAX(last_passed_at) AS last_passed_at FROM proxies`,
        ),
      ]);

    // p95 latency: offset computed here (not in SQL) so small pools still report the high tail.
    const latencySamples = latency?.count ?? 0;
    const p95Offset = Math.max(0, Math.ceil(latencySamples * 0.95) - 1);
    const p95Row =
      latencySamples > 0
        ? await this.db.get<{ latency_ms: number }>(
            `SELECT latency_ms FROM proxies WHERE ${poolWhere} AND latency_ms IS NOT NULL
             ORDER BY latency_ms ASC LIMIT 1 OFFSET ?`,
            [...poolArgs, p95Offset],
          )
        : null;

    const byProtocol = Object.fromEntries(
      PROXY_PROTOCOLS.map((protocol: ProxyProtocol) => [protocol, 0]),
    ) as Record<ProxyProtocol, number>;
    for (const row of protocolRows) byProtocol[row.protocol] = row.count;

    const checks = reliability?.checks ?? 0;
    const passes = reliability?.passes ?? 0;

    return {
      pool_size: statusCounts.active,
      active: statusCounts.active,
      quarantined: statusCounts.quarantined,
      dead: statusCounts.dead,
      pending: statusCounts.pending,
      total_known: statusCounts.total,
      by_protocol: byProtocol,
      avg_latency_ms:
        latency?.avg === null || latency?.avg === undefined ? null : Math.round(latency.avg),
      p95_latency_ms: p95Row?.latency_ms ?? null,
      min_latency_ms: latency?.min ?? null,
      max_latency_ms: latency?.max ?? null,
      avg_score: scoreRow?.avg_score == null ? null : Math.round(scoreRow.avg_score * 10) / 10,
      pass_rate: checks > 0 ? Math.round((passes / checks) * 10_000) / 10_000 : null,
      service_passed: servicePassed?.count ?? 0,
      last_update: lastUpdate?.last_checked_at ?? lastUpdate?.last_passed_at ?? null,
    };
  }

  /** Retention: keep history small so Turso rows stay cheap. */
  async pruneHistory(options: {
    resultRetentionDays: number;
    deadProxyRetentionDays: number;
    cycleRetentionDays: number;
    nowIso?: string;
  }): Promise<{
    validation_results: number;
    service_results: number;
    proxies: number;
    refresh_cycles: number;
  }> {
    const now = Date.parse(options.nowIso ?? new Date().toISOString());
    const resultsCutoff = new Date(now - options.resultRetentionDays * 86_400_000).toISOString();
    const proxyCutoff = new Date(now - options.deadProxyRetentionDays * 86_400_000).toISOString();
    const cycleCutoff = new Date(now - options.cycleRetentionDays * 86_400_000).toISOString();

    const validation = await this.db.run(`DELETE FROM validation_results WHERE created_at < ?`, [
      resultsCutoff,
    ]);
    const service = await this.db.run(`DELETE FROM service_results WHERE created_at < ?`, [
      resultsCutoff,
    ]);
    const proxies = await this.db.run(
      `DELETE FROM proxies WHERE status = 'dead' AND last_seen < ? AND last_passed_at IS NULL`,
      [proxyCutoff],
    );
    const cycles = await this.db.run(
      `DELETE FROM refresh_cycles WHERE status <> 'running' AND COALESCE(finished_at, started_at) < ?`,
      [cycleCutoff],
    );
    return {
      validation_results: validation.rowsAffected,
      service_results: service.rowsAffected,
      proxies: proxies.rowsAffected,
      refresh_cycles: cycles.rowsAffected,
    };
  }
}

interface PublicProxyRow {
  id: number;
  host: string;
  port: number;
  protocol: ProxyProtocol;
  source: string;
  score: number;
  latency_ms: number | null;
  country: string | null;
  anonymity: AnonymityLevel;
  last_passed: string | null;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    out.push(items.slice(start, start + size) as T[]);
  return out;
}
