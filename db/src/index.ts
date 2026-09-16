/**
 * @proxypulse/db — Turso/libSQL access layer: connection, migrations and repositories.
 */

export * from './types.js';
export * from './client.js';
export * from './migrate.js';
export { ProxiesRepository } from './repositories/proxies.js';
export type {
  CandidateInput,
  PoolReadQuery,
  PoolReadResult,
  ServiceOutcome,
  UpsertResult,
  ValidationOutcome,
} from './repositories/proxies.js';
export { CyclesRepository } from './repositories/cycles.js';
export { ValidationResultsRepository, ServiceResultsRepository } from './repositories/results.js';
export type { ValidationResultInput, ErrorBreakdownRow } from './repositories/results.js';
export { MetaRepository, META_KEYS } from './repositories/meta.js';
export type { MetaKey } from './repositories/meta.js';
export type { InStatement, InValue } from '@libsql/client';
