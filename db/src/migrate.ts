/**
 * Migration runner. Migration files live in `db/migrations/NNN_name.sql`, are applied in filename
 * order, each inside its own transaction, and are tracked in `_schema_migrations` so re-running is
 * a no-op. Works against a local file database and Turso alike.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Logger } from '@proxypulse/shared';

import { splitSqlStatements, type DbHandle } from './client.js';

export interface MigrationFile {
  name: string;
  sql: string;
}

export interface MigrateResult {
  applied: string[];
  already_applied: string[];
  version: string | null;
}

const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS _schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
)`;

/** Walks upwards from `startDir` looking for a `migrations` folder containing .sql files. */
/** Resolves the default migrations directory for both `src` (tests) and `dist` (production). */
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../migrations', import.meta.url));
}

export function findMigrationsDir(startDir: string = dirname(defaultMigrationsDir())): string {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, 'migrations');
    if (existsSync(candidate)) {
      const files = readdirSync(candidate).filter((file) => file.endsWith('.sql'));
      if (files.length > 0) return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate db/migrations containing .sql files (set DATABASE_MIGRATIONS_DIR or run from the repository root)',
  );
}

export function readMigrations(dir: string = findMigrationsDir()): MigrationFile[] {
  return readdirSync(dir)
    .filter((file) => /^\d+_.*\.sql$/.test(file))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((file) => ({ name: file, sql: readFileSync(join(dir, file), 'utf8') }));
}

function checksum(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export async function applyMigrations(
  db: DbHandle,
  options: { dir?: string; logger?: Logger } = {},
): Promise<MigrateResult> {
  const logger = options.logger;
  const files = readMigrations(options.dir ?? findMigrationsDir());
  await db.client.execute(MIGRATIONS_TABLE_SQL);

  const appliedRows = await db.all<{ name: string }>('SELECT name FROM _schema_migrations');
  const appliedNames = new Set(appliedRows.map((row) => row.name));
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const file of files) {
    if (appliedNames.has(file.name)) {
      alreadyApplied.push(file.name);
      continue;
    }
    const statements = splitSqlStatements(file.sql);
    if (statements.length === 0) continue;
    logger?.info('applying migration', {
      event: 'DB_MIGRATION_APPLIED',
      migration: file.name,
      statements: statements.length,
    });
    // client.batch() runs the statements in a single transaction (atomic on both
    // the local database and Turso), so no explicit BEGIN/COMMIT is needed here.
    await db.batch(
      [
        ...statements.map((sql) => ({ sql })),
        {
          sql: 'INSERT INTO _schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)',
          args: [file.name, new Date().toISOString(), checksum(file.sql)],
        },
      ],
      'write',
    );
    applied.push(file.name);
  }

  const latest = await db.get<{ name: string }>('SELECT MAX(name) AS name FROM _schema_migrations');
  return { applied, already_applied: alreadyApplied, version: latest?.name ?? null };
}

/** Cheap guard used at worker startup so a missing migration produces a clear error. */
export async function assertSchemaReady(
  db: DbHandle,
): Promise<{ tables: string[]; missing: string[] }> {
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  const tables = new Set(rows.map((row) => row.name));
  const required = ['proxies', 'validation_results', 'service_results', 'refresh_cycles', 'meta'];
  return { tables: [...tables], missing: required.filter((table) => !tables.has(table)) };
}
