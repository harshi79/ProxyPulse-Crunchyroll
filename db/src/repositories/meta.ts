/**
 * `meta` key/value store: cycle scheduling info and small cached aggregates that the public API
 * reads on every request (so /stats and /tpool never need a full table scan).
 */

import { type DbHandle } from '../client.js';

export const META_KEYS = {
  nextRunAt: 'scheduler.next_run_at',
  currentCycleId: 'scheduler.current_cycle_id',
  lastCompletedCycleId: 'scheduler.last_completed_cycle_id',
  lastCycleError: 'scheduler.last_cycle_error',
  statsSnapshot: 'cache.stats_snapshot',
  lastPruneAt: 'maintenance.last_prune_at',
} as const;

export type MetaKey = (typeof META_KEYS)[keyof typeof META_KEYS];

export class MetaRepository {
  constructor(private readonly db: DbHandle) {}

  async get(key: MetaKey): Promise<string | null> {
    const row = await this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  async set(
    key: MetaKey,
    value: string,
    updatedAt: string = new Date().toISOString(),
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, updatedAt],
    );
  }

  async getJson<T>(key: MetaKey): Promise<T | null> {
    const raw = await this.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: MetaKey, value: unknown, updatedAt?: string): Promise<void> {
    await this.set(key, JSON.stringify(value), updatedAt);
  }

  async remove(key: MetaKey): Promise<void> {
    await this.db.run('DELETE FROM meta WHERE key = ?', [key]);
  }
}
