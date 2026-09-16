/**
 * Refresh cycle bookkeeping. One row per cycle, written at start and at completion, plus the
 * "latest completed cycle" projection that backs GET /tpool.
 */

import { type RefreshCycleRecord } from '@proxypulse/shared';

import { type DbHandle } from '../client.js';
import { type RefreshCycleRow } from '../types.js';

const CYCLE_COLUMNS = `cycle_id, status, started_at, finished_at, candidates_discovered, candidates_new,
  candidates_checked, candidates_passed, candidates_failed, service_checked, service_passed,
  pool_size, pool_added, pool_quarantined, pool_expired, duration_ms, error`;

export class CyclesRepository {
  constructor(private readonly db: DbHandle) {}

  async start(cycleId: string, startedAt: string): Promise<void> {
    await this.db.run(
      `INSERT INTO refresh_cycles (cycle_id, status, started_at) VALUES (?, 'running', ?)
       ON CONFLICT (cycle_id) DO UPDATE SET status = 'running', started_at = excluded.started_at, error = NULL`,
      [cycleId, startedAt],
    );
  }

  async complete(
    cycleId: string,
    record: Omit<RefreshCycleRecord, 'cycle_id' | 'status' | 'started_at'>,
  ): Promise<void> {
    await this.db.run(
      `UPDATE refresh_cycles SET
          status = 'completed',
          finished_at = ?,
          candidates_discovered = ?,
          candidates_new = ?,
          candidates_checked = ?,
          candidates_passed = ?,
          candidates_failed = ?,
          service_checked = ?,
          service_passed = ?,
          pool_size = ?,
          pool_added = ?,
          pool_quarantined = ?,
          pool_expired = ?,
          duration_ms = ?,
          error = NULL
        WHERE cycle_id = ?`,
      [
        record.finished_at,
        record.candidates_discovered,
        record.candidates_new,
        record.candidates_checked,
        record.candidates_passed,
        record.candidates_failed,
        record.service_checked,
        record.service_passed,
        record.pool_size,
        record.pool_added,
        record.pool_quarantined,
        record.pool_expired,
        record.duration_ms,
        cycleId,
      ],
    );
  }

  async fail(
    cycleId: string,
    finishedAt: string,
    error: string,
    durationMs: number,
  ): Promise<void> {
    await this.db.run(
      `UPDATE refresh_cycles SET status = 'failed', finished_at = ?, duration_ms = ?, error = ? WHERE cycle_id = ?`,
      [finishedAt, durationMs, error.slice(0, 500), cycleId],
    );
  }

  async latestCompleted(): Promise<RefreshCycleRow | null> {
    return this.db.get<RefreshCycleRow>(
      `SELECT ${CYCLE_COLUMNS} FROM refresh_cycles WHERE status = 'completed' ORDER BY finished_at DESC LIMIT 1`,
    );
  }

  async current(): Promise<RefreshCycleRow | null> {
    return this.db.get<RefreshCycleRow>(
      `SELECT ${CYCLE_COLUMNS} FROM refresh_cycles WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`,
    );
  }

  async list(limit = 20): Promise<RefreshCycleRow[]> {
    return this.db.all<RefreshCycleRow>(
      `SELECT ${CYCLE_COLUMNS} FROM refresh_cycles ORDER BY started_at DESC LIMIT ?`,
      [Math.min(Math.max(1, limit), 500)],
    );
  }

  /** A cycle row left as `running` means the previous process died mid-cycle. */
  async recoverAbandoned(nowIso: string): Promise<number> {
    const result = await this.db.run(
      `UPDATE refresh_cycles SET status = 'failed', finished_at = ?, error = 'abandoned: worker restarted mid-cycle'
        WHERE status = 'running'`,
      [nowIso],
    );
    return result.rowsAffected;
  }

  async get(cycleId: string): Promise<RefreshCycleRow | null> {
    return this.db.get<RefreshCycleRow>(
      `SELECT ${CYCLE_COLUMNS} FROM refresh_cycles WHERE cycle_id = ?`,
      [cycleId],
    );
  }
}
