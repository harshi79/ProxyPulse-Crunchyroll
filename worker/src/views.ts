/**
 * Response builders for the worker's internal JSON API. The Cloudflare gateway forwards these
 * verbatim, so this is the single place where the public payload shape is decided — and the place
 * where "never expose credentials or internal details" is enforced.
 */

import {
  HTTP_STATUS_FOR_ERROR,
  parsePoolQuery,
  weightedRandomPick,
  type ApiErrorCode,
  type PoolStats,
} from '@proxypulse/shared';
import {
  type CyclesRepository,
  type MetaRepository,
  META_KEYS,
  type ProxiesRepository,
  type ServiceResultsRepository,
  type ValidationResultsRepository,
} from '@proxypulse/db';
import type { CheckerStats } from '@proxypulse/service-crunchyroll';

import type { WorkerConfig } from './config.js';
import type { SchedulerStatus } from './pipeline/scheduler.js';

export interface ViewContext {
  config: WorkerConfig;
  proxies: ProxiesRepository;
  cycles: CyclesRepository;
  meta: MetaRepository;
  serviceResults: ServiceResultsRepository;
  validations: ValidationResultsRepository;
  schedulerStatus: () => SchedulerStatus;
  serviceCheckerStats: () => CheckerStats;
  version: string;
  now?: () => number;
  dbPing: () => Promise<{ ok: boolean; latency_ms: number; error?: string }>;
}

export interface ViewResult {
  status: number;
  data: Record<string, unknown>;
  /** Optional envelope overrides (pool_size / last_update are filled in by the caller if absent). */
  meta?: { pool_size?: number | null; last_update?: string | null };
  error?: { code: ApiErrorCode; message: string };
}

const iso = (ms: number): string => new Date(ms).toISOString();

export const errorView = (code: ApiErrorCode, message: string): ViewResult => ({
  status: HTTP_STATUS_FOR_ERROR[code],
  data: {},
  error: { code, message },
});

/** Seconds until the next scheduled refresh (used by clients to avoid hammering). */
const nextRefreshIn = (nextRunAt: string | null, nowMs: number): number | null => {
  if (!nextRunAt) return null;
  const at = Date.parse(nextRunAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((at - nowMs) / 1000));
};

export async function poolView(ctx: ViewContext, params: URLSearchParams): Promise<ViewResult> {
  const nowMs = ctx.now?.() ?? Date.now();
  const parsed = parsePoolQuery(params);
  if (parsed.error) return errorView('bad_request', parsed.error);
  const query = parsed.query;

  const read = await ctx.proxies.readPool({
    limit: query.limit,
    offset: query.offset,
    protocol: query.protocol as 'http' | 'https' | 'socks4' | 'socks5' | null,
    minScore: query.minScore,
    maxLatencyMs: query.maxLatencyMs,
    country: query.country,
    service: query.service,
    ttlMinutes: ctx.config.pool.ttlMinutes,
    nowIso: iso(nowMs),
  });

  return {
    status: 200,
    meta: { pool_size: read.total, last_update: read.entries[0]?.last_passed ?? null },
    data: {
      service: ctx.config.service,
      pool_size: read.total,
      count: read.entries.length,
      limit: query.limit,
      offset: query.offset,
      returned_at: iso(nowMs),
      next_refresh_in_seconds: nextRefreshIn(await ctx.meta.get(META_KEYS.nextRunAt), nowMs),
      filters: {
        protocol: query.protocol,
        min_score: query.minScore,
        max_latency_ms: query.maxLatencyMs,
        country: query.country,
        service: query.service,
      },
      ...(parsed.warnings.length > 0 ? { warnings: parsed.warnings } : {}),
      proxies: read.entries,
    },
  };
}

export async function randomView(ctx: ViewContext, params: URLSearchParams): Promise<ViewResult> {
  const nowMs = ctx.now?.() ?? Date.now();
  const parsed = parsePoolQuery(params);
  if (parsed.error) return errorView('bad_request', parsed.error);

  // Sample the top slice of the pool, then pick with a score-weighted random so the fastest and most
  // reliable proxies show up more often without the pool collapsing onto a single entry.
  const read = await ctx.proxies.readPool({
    limit: 200,
    offset: 0,
    protocol: parsed.query.protocol as 'http' | 'https' | 'socks4' | 'socks5' | null,
    minScore: parsed.query.minScore,
    maxLatencyMs: parsed.query.maxLatencyMs,
    country: parsed.query.country,
    service: parsed.query.service,
    ttlMinutes: ctx.config.pool.ttlMinutes,
    nowIso: iso(nowMs),
  });

  const picked = weightedRandomPick(read.entries);
  if (!picked) {
    return {
      status: 503,
      data: {},
      meta: { pool_size: 0, last_update: null },
      error: {
        code: 'unavailable',
        message: 'no healthy proxies currently match the pool criteria',
      },
    };
  }
  return {
    status: 200,
    meta: { pool_size: read.total, last_update: picked.last_passed },
    data: { service: ctx.config.service, pool_size: read.total, proxy: picked },
  };
}

export async function statsView(ctx: ViewContext, params: URLSearchParams): Promise<ViewResult> {
  const nowMs = ctx.now?.() ?? Date.now();
  const includeErrors = params.get('errors') === '1';
  const stats: PoolStats = await ctx.proxies.stats({
    ttlMinutes: ctx.config.pool.ttlMinutes,
    service: ctx.config.service,
    requireServicePass: ctx.config.pool.requireServicePass,
    nowIso: iso(nowMs),
  });
  const latestCycle = await ctx.cycles.latestCompleted();
  const nextRunAt = await ctx.meta.get(META_KEYS.nextRunAt);
  const scheduler = ctx.schedulerStatus();

  const data: Record<string, unknown> = {
    service: ctx.config.service,
    ...stats,
    pool: {
      size: stats.pool_size,
      min_score: ctx.config.pool.minScore,
      max_active: ctx.config.pool.maxActive,
      ttl_minutes: ctx.config.pool.ttlMinutes,
      require_service_pass: ctx.config.pool.requireServicePass,
    },
    refresh: {
      interval_minutes: ctx.config.refresh.intervalMinutes,
      next_refresh_in_seconds: nextRefreshIn(nextRunAt, nowMs),
      last_cycle: latestCycle
        ? {
            cycle_id: latestCycle.cycle_id,
            started_at: latestCycle.started_at,
            finished_at: latestCycle.finished_at,
            duration_ms: latestCycle.duration_ms,
            candidates_discovered: latestCycle.candidates_discovered,
            candidates_checked: latestCycle.candidates_checked,
            candidates_passed: latestCycle.candidates_passed,
            candidates_failed: latestCycle.candidates_failed,
            pool_size: latestCycle.pool_size,
          }
        : null,
      running: scheduler.running,
      cycles_completed: scheduler.cycles_completed,
      cycles_failed: scheduler.cycles_failed,
    },
    service_check: {
      enabled: ctx.config.serviceCheck.enabled,
      endpoint: ctx.serviceCheckerStats().probe_url,
      checks: ctx.serviceCheckerStats().checks,
      passed: ctx.serviceCheckerStats().passed,
      blocked: ctx.serviceCheckerStats().blocked,
      failed: ctx.serviceCheckerStats().failed,
      skipped: ctx.serviceCheckerStats().skipped,
      rate_limit_per_minute: ctx.config.serviceCheck.rateLimitPerMinute,
      max_checks_per_cycle: ctx.config.serviceCheck.maxChecksPerCycle,
      circuit: ctx.serviceCheckerStats().circuit,
      robots: ctx.serviceCheckerStats().robots,
      cooldown: ctx.serviceCheckerStats().in_cooldown,
    },
    worker: {
      version: ctx.version,
      environment: ctx.config.environment,
      uptime_ms: scheduler.uptime_ms,
      started_at: scheduler.started_at,
    },
  };

  if (includeErrors && latestCycle) {
    const breakdown = await ctx.validations.errorBreakdown(latestCycle.cycle_id);
    data.last_cycle_errors = breakdown
      .filter((row) => row.error_code)
      .slice(0, 8)
      .map((row) => ({ code: row.error_code, count: row.count }));
    data.last_cycle_service_reasons = await ctx.serviceResults.reasonBreakdown({
      service: ctx.config.service,
      limit: 5,
    });
  }

  return {
    status: 200,
    data,
    meta: { pool_size: stats.pool_size, last_update: stats.last_update },
  };
}

/** `GET /tpool` — compact summary of the latest completed *test* cycle. */
export async function tpoolView(ctx: ViewContext): Promise<ViewResult> {
  const nowMs = ctx.now?.() ?? Date.now();
  const latest = await ctx.cycles.latestCompleted();
  const valid = await ctx.serviceResults.countCurrentlyValid({
    service: ctx.config.service,
    ttlMinutes: ctx.config.pool.ttlMinutes,
    nowIso: iso(nowMs),
  });
  const nextRunAt = await ctx.meta.get(META_KEYS.nextRunAt);
  const lastCheck = latest?.finished_at ?? null;
  const computedNext =
    nextRunAt ??
    (lastCheck
      ? iso(Date.parse(lastCheck) + ctx.config.refresh.intervalMinutes * 60_000)
      : iso(nowMs + ctx.config.refresh.intervalMinutes * 60_000));

  return {
    status: 200,
    meta: { pool_size: latest?.pool_size ?? 0, last_update: lastCheck },
    data: {
      service: ctx.config.service,
      valid,
      last_check: lastCheck,
      next_check: computedNext,
      cycle: latest
        ? {
            cycle_id: latest.cycle_id,
            status: latest.status,
            started_at: latest.started_at,
            finished_at: latest.finished_at,
            duration_ms: latest.duration_ms,
            candidates_discovered: latest.candidates_discovered,
            candidates_checked: latest.candidates_checked,
            candidates_passed: latest.candidates_passed,
            candidates_failed: latest.candidates_failed,
            service_checked: latest.service_checked,
            service_passed: latest.service_passed,
            pool_size: latest.pool_size,
          }
        : null,
    },
  };
}

export async function cyclesView(ctx: ViewContext, params: URLSearchParams): Promise<ViewResult> {
  const limit = Math.min(100, Math.max(1, Number(params.get('limit') ?? 20) || 20));
  const rows = await ctx.cycles.list(limit);
  return {
    status: 200,
    data: {
      service: ctx.config.service,
      cycles: rows.map((row) => ({
        cycle_id: row.cycle_id,
        status: row.status,
        started_at: row.started_at,
        finished_at: row.finished_at,
        duration_ms: row.duration_ms,
        candidates_discovered: row.candidates_discovered,
        candidates_new: row.candidates_new,
        candidates_checked: row.candidates_checked,
        candidates_passed: row.candidates_passed,
        candidates_failed: row.candidates_failed,
        service_checked: row.service_checked,
        service_passed: row.service_passed,
        pool_size: row.pool_size,
        pool_added: row.pool_added,
        pool_quarantined: row.pool_quarantined,
        pool_expired: row.pool_expired,
        error: row.error,
      })),
    },
  };
}

export async function healthView(ctx: ViewContext): Promise<ViewResult> {
  const db = await ctx.dbPing();
  const scheduler = ctx.schedulerStatus();
  const healthy = db.ok;
  return {
    status: healthy ? 200 : 503,
    data: {
      ok: healthy,
      service: ctx.config.service,
      version: ctx.version,
      environment: ctx.config.environment,
      uptime_ms: scheduler.uptime_ms,
      database: { ok: db.ok, latency_ms: db.latency_ms },
      scheduler: {
        running: scheduler.running,
        next_run_at: scheduler.next_run_at,
        cycles_completed: scheduler.cycles_completed,
        cycles_failed: scheduler.cycles_failed,
        interval_minutes: scheduler.interval_minutes,
        stopping: scheduler.stopping,
      },
      ...(healthy ? {} : { error: 'database unavailable' }),
    },
  };
}
