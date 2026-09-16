#!/usr/bin/env node
/**
 * Database CLI (Node.js maintenance tool, not used at request time):
 *
 *   node db/dist/cli.js migrate   # apply pending migrations (default)
 *   node db/dist/cli.js status    # schema + row counts + latest cycle
 *   node db/dist/cli.js prune     # delete history older than RETENTION_DAYS (default 7)
 *
 * Configuration comes from the environment: DATABASE_URL, DATABASE_AUTH_TOKEN, RETENTION_DAYS.
 */

import { createDb } from './client.js';
import {
  applyMigrations,
  assertSchemaReady,
  findMigrationsDir,
  readMigrations,
} from './migrate.js';
import { CyclesRepository } from './repositories/cycles.js';
import { ProxiesRepository } from './repositories/proxies.js';

const rawUrl = process.env['DATABASE_URL'] ?? 'file:./data/proxypulse.db';
const url = rawUrl.startsWith('file:./')
  ? `file:${process.cwd()}/${rawUrl.slice('file:./'.length)}`
  : rawUrl;
const command = process.argv[2] ?? 'migrate';
const retentionDays = Number(process.env['RETENTION_DAYS'] ?? '7');

const db = createDb({
  url,
  ...(process.env['DATABASE_AUTH_TOKEN'] ? { authToken: process.env['DATABASE_AUTH_TOKEN'] } : {}),
});
const proxies = new ProxiesRepository(db);
const cycles = new CyclesRepository(db);

const print = (value: unknown): void => {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
};

try {
  if (command === 'migrate') {
    const dir = process.env['DATABASE_MIGRATIONS_DIR'] ?? findMigrationsDir();
    print(
      `migrations: ${readMigrations(dir)
        .map((file) => file.name)
        .join(', ')}`,
    );
    const result = await applyMigrations(db, { dir });
    print(`applied: ${result.applied.length > 0 ? result.applied.join(', ') : 'none'}`);
    print(`version: ${result.version ?? 'unknown'}`);
    print(`database: ${db.url}`);
  } else if (command === 'status') {
    const ready = await assertSchemaReady(db);
    const counts =
      ready.missing.length === 0
        ? await db.all<{ name: string; count: number }>(
            `SELECT 'proxies' AS name, COUNT(*) AS count FROM proxies
             UNION ALL SELECT 'validation_results', COUNT(*) FROM validation_results
             UNION ALL SELECT 'service_results', COUNT(*) FROM service_results
             UNION ALL SELECT 'refresh_cycles', COUNT(*) FROM refresh_cycles`,
          )
        : [];
    const byStatus =
      ready.missing.length === 0
        ? await db.all<{ status: string; count: number }>(
            'SELECT status, COUNT(*) AS count FROM proxies GROUP BY status',
          )
        : [];
    print({
      database: db.url,
      schema: ready,
      counts: Object.fromEntries(counts.map((row) => [row.name, row.count])),
      by_status: byStatus,
      latest_completed_cycle: ready.missing.length === 0 ? await cycles.latestCompleted() : null,
    });
  } else if (command === 'prune') {
    const result = await proxies.pruneHistory({
      resultRetentionDays: retentionDays,
      deadProxyRetentionDays: retentionDays,
      cycleRetentionDays: Math.max(retentionDays, 30),
    });
    print({ pruned: result, retention_days: retentionDays });
  } else {
    throw new Error(`unknown command "${command}" (expected migrate | status | prune)`);
  }
} catch (error) {
  print(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
