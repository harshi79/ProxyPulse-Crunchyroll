/**
 * Row shapes returned by the repositories. Mirrors db/migrations/*.sql.
 */

import {
  type AnonymityLevel,
  type ProxyProtocol,
  type ProxyStatus,
  type ServiceStatus,
  type ValidationStatus,
} from '@proxypulse/shared';

export interface ProxyRow {
  id: number;
  dedupe_key: string;
  host: string;
  port: number;
  protocol: ProxyProtocol;
  username: string | null;
  password: string | null;
  source: string;
  status: ProxyStatus;
  validation_status: ValidationStatus;
  service_status: ServiceStatus;
  score: number;
  latency_ms: number | null;
  service_latency_ms: number | null;
  service_checked_at: string | null;
  service_fail_reason: string | null;
  last_error_code: string | null;
  country: string | null;
  anonymity: AnonymityLevel;
  first_seen: string;
  last_seen: string;
  first_cycle_id: string | null;
  last_cycle_id: string | null;
  last_checked_at: string | null;
  last_passed_at: string | null;
  consecutive_failures: number;
  check_count: number;
  pass_count: number;
  notes: string | null;
}

export interface ValidationResultRow {
  id: number;
  proxy_id: number;
  cycle_id: string;
  created_at: string;
  reachable: 0 | 1;
  latency_ms: number | null;
  protocol: ProxyProtocol;
  transport: string | null;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  duration_ms: number;
}

export interface ServiceResultRow {
  id: number;
  proxy_id: number;
  cycle_id: string;
  service: string;
  created_at: string;
  passed: 0 | 1;
  status: ServiceStatus;
  http_status: number | null;
  latency_ms: number | null;
  reason: string | null;
  details: string | null;
}

export interface RefreshCycleRow {
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

export interface PoolStatusCounts {
  active: number;
  quarantined: number;
  dead: number;
  new: number;
  pending: number;
  total: number;
}
