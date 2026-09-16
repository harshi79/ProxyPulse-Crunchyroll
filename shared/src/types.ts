/**
 * Core domain types shared by the worker, the Cloudflare API and the service adapters.
 * Everything here is runtime-agnostic (no Node.js or Workers specific APIs).
 */

export const PROXY_PROTOCOLS = ['http', 'https', 'socks4', 'socks5'] as const;
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number];

export function isProxyProtocol(value: unknown): value is ProxyProtocol {
  return typeof value === 'string' && (PROXY_PROTOCOLS as readonly string[]).includes(value);
}

/**
 * Lifecycle of a proxy inside ProxyPulse.
 *
 * new          -> discovered, never validated
 * pending      -> queued for validation in the current cycle
 * active       -> healthy, eligible for the public pool
 * quarantined  -> too many consecutive failures, excluded from the public pool but kept for rechecks
 * dead         -> expired/stale or permanently broken; never returned by the public API
 */
export const PROXY_STATUSES = ['new', 'pending', 'active', 'quarantined', 'dead'] as const;
export type ProxyStatus = (typeof PROXY_STATUSES)[number];

export const VALIDATION_STATUSES = ['unchecked', 'passed', 'failed'] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

/** Result of the (optional) service compatibility check for a proxy. */
export const SERVICE_STATUSES = ['untested', 'passed', 'failed', 'blocked', 'skipped'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const ANONYMITY_LEVELS = ['elite', 'anonymous', 'transparent', 'unknown'] as const;
export type AnonymityLevel = (typeof ANONYMITY_LEVELS)[number];

/** The minimum information needed to dial a proxy. Never print `password` in a log. */
export interface ProxyEndpoint {
  host: string;
  port: number;
  protocol: ProxyProtocol;
  username?: string | undefined;
  password?: string | undefined;
}

/** A proxy as stored in the database (internal shape — may contain credentials). */
export interface ProxyRecord extends ProxyEndpoint {
  id: number;
  dedupe_key: string;
  source: string;
  status: ProxyStatus;
  score: number;
  latency_ms: number | null;
  validation_status: ValidationStatus;
  service_status: ServiceStatus;
  service_latency_ms: number | null;
  service_fail_reason: string | null;
  country: string | null;
  anonymity: AnonymityLevel;
  first_seen: string;
  last_seen: string;
  last_checked_at: string | null;
  last_passed_at: string | null;
  consecutive_failures: number;
  check_count: number;
  pass_count: number;
}

/** The only proxy shape the public API is allowed to return. No credentials, no internals. */
export interface PublicProxy {
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

export interface PoolStats {
  pool_size: number;
  active: number;
  quarantined: number;
  dead: number;
  pending: number;
  total_known: number;
  by_protocol: Record<ProxyProtocol, number>;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  min_latency_ms: number | null;
  max_latency_ms: number | null;
  avg_score: number | null;
  pass_rate: number | null;
  service_passed: number;
  last_update: string | null;
}

/** Compact summary of the latest *completed* test cycle (served by GET /tpool). */
export interface TpoolSummary {
  service: string;
  valid: number;
  last_check: string | null;
  next_check: string | null;
  cycle_id: string | null;
  cycle_status?: string;
  duration_ms?: number | null;
  candidates_discovered?: number;
  candidates_checked?: number;
  candidates_passed?: number;
  candidates_failed?: number;
  pool_size?: number;
}

export interface RefreshCycleRecord {
  cycle_id: string;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  finished_at: string | null;
  candidates_discovered: number;
  candidates_new: number;
  candidates_checked: number;
  candidates_passed: number;
  candidates_failed: number;
  service_checked: number;
  service_passed: number;
  pool_size: number;
  pool_added: number;
  pool_quarantined: number;
  pool_expired: number;
  duration_ms: number | null;
  error: string | null;
}

export const API_ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'conflict',
  'payload_too_large',
  'rate_limited',
  'timeout',
  'unavailable',
  'upstream_error',
  'internal_error',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const HTTP_STATUS_FOR_ERROR: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  timeout: 504,
  unavailable: 503,
  upstream_error: 502,
  internal_error: 500,
};

/** Common envelope for every public API response. */
export interface ApiMeta {
  request_id: string;
  timestamp: string;
  pool_size: number | null;
  last_update: string | null;
  service: string;
  cached?: boolean;
  /** Present when the gateway answered from cache while the origin was degraded. */
  stale?: boolean;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta: ApiMeta;
}

export interface ApiFailure {
  ok: false;
  error: { code: ApiErrorCode; message: string };
  meta: Pick<ApiMeta, 'request_id' | 'timestamp'>;
}
