/**
 * Thin, typed wrapper around the libSQL/Turso client.
 *
 * The same code path serves a local file (`file:./data/proxypulse.db`), an in-memory database
 * (`:memory:`, used by tests) and Turso (`libsql://...` + auth token). Nothing else in the
 * codebase imports @libsql/client directly, so swapping drivers later stays a one-file change.
 */

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { createClient, type Client, type InStatement, type InValue } from '@libsql/client';

export interface DbOptions {
  /** `file:<path>`, `:memory:` or `libsql://<instance>.turso.io` */
  url: string;
  /** Turso auth token. Never logged; keep it out of URLs. */
  authToken?: string | undefined;
  /** Optional observer for query counts/latency (used by /internal/healthz). */
  onQuery?: (info: { sql: string; ms: number; error?: boolean }) => void;
}

export interface DbHandle {
  readonly url: string;
  readonly client: Client;
  all<T>(sql: string, args?: InValue[]): Promise<T[]>;
  get<T>(sql: string, args?: InValue[]): Promise<T | null>;
  run(sql: string, args?: InValue[]): Promise<{ rowsAffected: number; lastInsertRowid: number }>;
  /** Executes statements atomically (single round trip on Turso). */
  batch(statements: InStatement[], mode?: 'write' | 'read'): Promise<void>;
  /** Connectivity probe used by the health endpoint. */
  ping(): Promise<{ ok: boolean; latency_ms: number; error?: string }>;
  close(): void;
}

const toNumber = (value: number | bigint): number =>
  typeof value === 'bigint' ? Number(value) : value;

/**
 * Splits a migration file into single statements. Our migrations contain no string literals with
 * semicolons and no trigger bodies, so a line-aware split is sufficient and keeps Turso happy
 * (the HTTP transport is one statement per request).
 */
export function splitSqlStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * A `file:` URL under a folder that does not exist yet is SQLITE_CANTOPEN (14) with a message nobody
 * recognises. Creating the parent is friendlier on a first run — `file:./data/proxypulse.db` should work
 * after a fresh clone, without a separate `mkdir`.
 */
function ensureLocalDatabaseDirectory(url: string): void {
  if (!url.startsWith('file:')) return;
  const path = url.slice('file:'.length);
  if (path.length === 0 || path.startsWith(':memory:')) return;
  const withoutQuery = path.split('?')[0] ?? path;
  if (withoutQuery.length === 0) return;
  const absolute = isAbsolute(withoutQuery) ? withoutQuery : resolve(process.cwd(), withoutQuery);
  try {
    mkdirSync(dirname(absolute), { recursive: true });
  } catch {
    /* a real permission problem surfaces from the connection attempt, with a better message */
  }
}

export function createDb(options: DbOptions): DbHandle {
  const url = options.url;
  ensureLocalDatabaseDirectory(url);
  const client = createClient(
    url.startsWith('libsql://') || url.startsWith('http')
      ? { url, authToken: options.authToken }
      : { url },
  );

  const timed = async <T>(sql: string, fn: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      const value = await fn();
      options.onQuery?.({ sql, ms: Math.max(0, Math.round(performance.now() - started)) });
      return value;
    } catch (error) {
      options.onQuery?.({
        sql,
        ms: Math.max(0, Math.round(performance.now() - started)),
        error: true,
      });
      throw error;
    }
  };

  const handle: DbHandle = {
    url: describeDbUrl(url),
    client,
    async all<T>(sql: string, args: InValue[] = []): Promise<T[]> {
      const result = await timed(sql, () => client.execute({ sql, args }));
      return result.rows as unknown as T[];
    },
    async get<T>(sql: string, args: InValue[] = []): Promise<T | null> {
      const result = await timed(sql, () => client.execute({ sql, args }));
      const row = result.rows[0];
      return row ? (row as unknown as T) : null;
    },
    async run(sql: string, args: InValue[] = []) {
      const result = await timed(sql, () => client.execute({ sql, args }));
      return {
        rowsAffected: result.rowsAffected,
        lastInsertRowid: toNumber(result.lastInsertRowid ?? 0n),
      };
    },
    async batch(statements: InStatement[], mode: 'write' | 'read' = 'write'): Promise<void> {
      if (statements.length === 0) return;
      await timed(`BATCH(${statements.length})`, async () => {
        await client.batch(statements, mode);
      });
    },
    async ping() {
      const started = performance.now();
      try {
        await client.execute('SELECT 1 AS ok');
        return { ok: true, latency_ms: Math.max(0, Math.round(performance.now() - started)) };
      } catch (error) {
        return {
          ok: false,
          latency_ms: Math.max(0, Math.round(performance.now() - started)),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    close(): void {
      client.close();
    },
  };

  return handle;
}

/** Never leak a token or query string from a DSN into logs or responses. */
export function describeDbUrl(url: string): string {
  if (url.startsWith('libsql://')) {
    const withoutQuery = url.split('?')[0]!;
    return withoutQuery.replace(/\/\/[^@/]*@/, '//***@');
  }
  return url;
}
