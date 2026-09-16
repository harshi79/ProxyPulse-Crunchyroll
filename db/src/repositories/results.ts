/**
 * Validation and service result history. Append-only in the hot path; reads are always bounded and
 * mostly aggregates (they back /stats and /tpool).
 */

import { type InStatement } from '@libsql/client';

import { type DbHandle } from '../client.js';
import { type ServiceResultRow, type ValidationResultRow } from '../types.js';

export interface ValidationResultInput {
  proxy_id: number;
  cycle_id: string;
  created_at: string;
  reachable: boolean;
  latency_ms: number | null;
  protocol: string;
  transport: string | null;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  duration_ms: number;
}

export interface ErrorBreakdownRow {
  error_code: string | null;
  count: number;
}

export class ValidationResultsRepository {
  constructor(private readonly db: DbHandle) {}

  async insertMany(rows: readonly ValidationResultInput[]): Promise<void> {
    const statements: InStatement[] = rows.map((row) => ({
      sql: `INSERT INTO validation_results (proxy_id, cycle_id, created_at, reachable, latency_ms, protocol,
          transport, http_status, error_code, error_message, attempts, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.proxy_id,
        row.cycle_id,
        row.created_at,
        row.reachable ? 1 : 0,
        row.latency_ms,
        row.protocol,
        row.transport,
        row.http_status,
        row.error_code,
        row.error_message,
        row.attempts,
        row.duration_ms,
      ],
    }));
    for (let start = 0; start < statements.length; start += 200) {
      await this.db.batch(statements.slice(start, start + 200));
    }
  }

  async byCycle(cycleId: string, limit = 500): Promise<ValidationResultRow[]> {
    return this.db.all<ValidationResultRow>(
      `SELECT * FROM validation_results WHERE cycle_id = ? ORDER BY id DESC LIMIT ?`,
      [cycleId, Math.min(Math.max(1, limit), 5_000)],
    );
  }

  async errorBreakdown(cycleId: string): Promise<ErrorBreakdownRow[]> {
    return this.db.all<ErrorBreakdownRow>(
      `SELECT error_code, COUNT(*) AS count FROM validation_results
        WHERE cycle_id = ? AND reachable = 0 GROUP BY error_code ORDER BY count DESC`,
      [cycleId],
    );
  }

  async recentForProxy(proxyId: number, limit = 10): Promise<ValidationResultRow[]> {
    return this.db.all<ValidationResultRow>(
      `SELECT * FROM validation_results WHERE proxy_id = ? ORDER BY created_at DESC LIMIT ?`,
      [proxyId, Math.min(Math.max(1, limit), 100)],
    );
  }
}

export class ServiceResultsRepository {
  constructor(private readonly db: DbHandle) {}

  async summary(
    cycleId: string,
    service: string,
  ): Promise<{
    checked: number;
    passed: number;
    blocked: number;
    failed: number;
    avg_latency_ms: number | null;
    last_check: string | null;
  }> {
    const row = await this.db.get<{
      checked: number;
      passed: number;
      blocked: number;
      failed: number;
      avg_latency_ms: number | null;
      last_check: string | null;
    }>(
      `SELECT COUNT(*) AS checked,
              SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed,
              SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              AVG(CASE WHEN status = 'passed' THEN latency_ms END) AS avg_latency_ms,
              MAX(created_at) AS last_check
         FROM service_results WHERE cycle_id = ? AND service = ?`,
      [cycleId, service],
    );
    return {
      checked: row?.checked ?? 0,
      passed: row?.passed ?? 0,
      blocked: row?.blocked ?? 0,
      failed: row?.failed ?? 0,
      avg_latency_ms: row?.avg_latency_ms == null ? null : Math.round(row.avg_latency_ms),
      last_check: row?.last_check ?? null,
    };
  }

  /** Proxies that are currently valid for the service (backs `valid` in GET /tpool). */
  async countCurrentlyValid(options: {
    service: string;
    ttlMinutes: number;
    nowIso: string;
  }): Promise<number> {
    const cutoff = new Date(Date.parse(options.nowIso) - options.ttlMinutes * 60_000).toISOString();
    const row = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM proxies
        WHERE status = 'active' AND service_status = 'passed' AND last_passed_at >= ?`,
      [cutoff],
    );
    return row?.count ?? 0;
  }

  async latestForProxy(proxyId: number, service: string): Promise<ServiceResultRow | null> {
    return this.db.get<ServiceResultRow>(
      `SELECT * FROM service_results WHERE proxy_id = ? AND service = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [proxyId, service],
    );
  }

  async byCycle(cycleId: string, service: string, limit = 500): Promise<ServiceResultRow[]> {
    return this.db.all<ServiceResultRow>(
      `SELECT * FROM service_results WHERE cycle_id = ? AND service = ? ORDER BY id DESC LIMIT ?`,
      [cycleId, service, Math.min(Math.max(1, limit), 5_000)],
    );
  }

  /** Failure reasons for the latest completed cycle — surfaced (safe subset) in /stats. */
  async reasonBreakdown(options: {
    service: string;
    limit?: number;
  }): Promise<{ reason: string | null; count: number }[]> {
    const latest = await this.db.get<{ cycle_id: string }>(
      `SELECT cycle_id FROM service_results WHERE service = ? ORDER BY created_at DESC LIMIT 1`,
      [options.service],
    );
    if (!latest) return [];
    return this.db.all<{ reason: string | null; count: number }>(
      `SELECT reason, COUNT(*) AS count FROM service_results
        WHERE cycle_id = ? AND service = ? AND passed = 0 GROUP BY reason ORDER BY count DESC LIMIT ?`,
      [latest.cycle_id, options.service, Math.min(options.limit ?? 10, 50)],
    );
  }
}
