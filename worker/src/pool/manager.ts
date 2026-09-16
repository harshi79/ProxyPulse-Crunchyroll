/**
 * Pool management: turns validation + service outcomes into status transitions and scores, then runs
 * the rolling-pool sweeps (expiry, quarantine, capacity). The pool is never wiped between cycles —
 * healthy entries keep their state and are only re-checked on their own schedule.
 */

import {
  combineScores,
  formatProxyRedacted,
  LOG_EVENTS,
  minutesSince,
  scoreProxyDetailed,
  shouldQuarantine,
  type Logger,
  type ProxyProtocol,
  type ProxyStatus,
  type ServiceStatus,
  type ValidationStatus,
} from '@proxypulse/shared';
import {
  type ProxiesRepository,
  type ProxyRow,
  type ServiceOutcome,
  type ValidationOutcome as DbValidationOutcome,
} from '@proxypulse/db';

import type { WorkerConfig } from '../config.js';
import type { ValidationOutcome } from '../validation/checker.js';

const isoNow = (nowMs: number): string => new Date(nowMs).toISOString();

export interface ValidatedOutcome {
  proxy_id: number;
  outcome: ValidationOutcome;
}

export interface ServiceStageResult {
  proxy_id: number;
  status: ServiceStatus;
  latency_ms: number | null;
  http_status: number | null;
  reason: string | null;
  details: Record<string, string | number | boolean> | null;
  /** 0..1 quality factor from the service adapter (null = no verdict). */
  quality: number | null;
}

export interface ValidationPlan {
  updates: DbValidationOutcome[];
  tally: {
    checked: number;
    passed: number;
    failed: number;
    added: number;
    retained: number;
    quarantined: number;
  };
}

export class PoolManager {
  constructor(
    private readonly deps: {
      proxies: ProxiesRepository;
      config: WorkerConfig;
      logger: Logger;
    },
  ) {}

  private get scoring() {
    const { scoring, pool } = this.deps.config;
    return {
      ...scoring,
      poolTtlMinutes: pool.ttlMinutes,
      maxConsecutiveFailures: pool.maxConsecutiveFailures,
      minPoolScore: pool.minScore,
      idealLatencyMs: pool.idealLatencyMs,
      maxLatencyMs: pool.maxLatencyMs,
    };
  }

  /**
   * Status transitions (rolling pool rules):
   *   pass  -> active when the score clears POOL_MIN_SCORE, otherwise quarantined (`low_score`)
   *   fail  -> a single blip keeps a proven pool member, the failure threshold quarantines it, and a
   *            never-passed proxy that fails 3x the threshold is declared dead
   */
  planValidation(
    rows: readonly ProxyRow[],
    outcomes: readonly ValidatedOutcome[],
    options: { cycleId: string; nowMs: number; trustByDedupeKey: Map<string, number> },
  ): ValidationPlan {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const nowIso = isoNow(options.nowMs);
    const config = this.scoring;
    const updates: DbValidationOutcome[] = [];
    const tally = { checked: 0, passed: 0, failed: 0, added: 0, retained: 0, quarantined: 0 };

    for (const { proxy_id, outcome } of outcomes) {
      const row = byId.get(proxy_id);
      if (!row) continue;
      tally.checked += 1;

      const passed = outcome.reachable;
      if (passed) tally.passed += 1;
      else tally.failed += 1;

      const consecutiveFailures = passed ? 0 : row.consecutive_failures + 1;
      const checkCount = row.check_count + 1;
      const passCount = row.pass_count + (passed ? 1 : 0);
      const serviceStatus = row.service_status as ServiceStatus;
      const sourceTrust = options.trustByDedupeKey.get(row.dedupe_key) ?? 0.5;

      const { score, reasons } = scoreProxyDetailed(
        {
          validationPassed: passed,
          latencyMs: passed ? outcome.latency_ms : null,
          checkCount,
          passCount,
          consecutiveFailures,
          minutesSinceLastPass: passed ? 0 : minutesSince(row.last_passed_at, options.nowMs),
          serviceStatus,
          serviceBlocked: serviceStatus === 'blocked',
          sourceTrust,
          anonymity: row.anonymity,
        },
        config,
      );

      let status: ProxyStatus;
      let notes: string | null = null;
      if (passed) {
        if (score >= config.minPoolScore) {
          status = 'active';
          if (row.status === 'active') tally.retained += 1;
          else tally.added += 1;
        } else {
          status = 'quarantined';
          notes = `low_score:${score}`;
          tally.quarantined += 1;
        }
      } else if (shouldQuarantine(consecutiveFailures, config)) {
        const hopeless =
          row.last_passed_at === null && consecutiveFailures >= config.maxConsecutiveFailures * 3;
        status = hopeless ? 'dead' : 'quarantined';
        notes = hopeless ? 'unrecoverable' : `failures:${consecutiveFailures}`;
        if (status === 'quarantined') tally.quarantined += 1;
      } else if (row.status === 'active') {
        status = 'active';
        notes = `transient_failure:${consecutiveFailures}`;
        tally.retained += 1;
      } else {
        status = row.status === 'quarantined' ? 'quarantined' : 'new';
        notes = `failures:${consecutiveFailures}`;
        if (status === 'quarantined') tally.quarantined += 1;
      }

      updates.push({
        id: row.id,
        cycle_id: options.cycleId,
        created_at: nowIso,
        reachable: passed,
        latency_ms: passed ? outcome.latency_ms : null,
        protocol: row.protocol as ProxyProtocol,
        transport: outcome.transport,
        http_status: outcome.http_status,
        error_code: outcome.error_code,
        error_message: outcome.error_message,
        attempts: outcome.attempts,
        duration_ms: outcome.duration_ms,
        status,
        validation_status: (passed ? 'passed' : 'failed') as ValidationStatus,
        consecutive_failures: consecutiveFailures,
        score,
        service_status: serviceStatus,
        notes,
      });

      this.deps.logger.debug('pool decision', {
        event: LOG_EVENTS.SCORING_COMPLETED,
        cycle_id: options.cycleId,
        proxy_id: row.id,
        proxy: formatProxyRedacted(row),
        status,
        score,
        score_reasons: reasons,
      });
    }

    return { updates, tally };
  }

  /** Service verdicts move the score (and therefore ranking); membership stays connectivity-driven. */
  planService(
    rows: readonly ProxyRow[],
    results: readonly ServiceStageResult[],
    options: { cycleId: string; nowMs: number },
  ): ServiceOutcome[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const nowIso = isoNow(options.nowMs);
    const planned: ServiceOutcome[] = [];

    for (const result of results) {
      const row = byId.get(result.proxy_id);
      if (!row) continue;
      const connectivity = scoreProxyDetailed(
        {
          validationPassed: row.validation_status !== 'failed',
          latencyMs: row.latency_ms,
          checkCount: row.check_count,
          passCount: row.pass_count,
          consecutiveFailures: row.consecutive_failures,
          minutesSinceLastPass: minutesSince(row.last_passed_at, options.nowMs),
          serviceStatus: result.status,
          serviceBlocked: result.status === 'blocked',
          anonymity: row.anonymity,
        },
        this.scoring,
      ).score;
      const score = combineScores(connectivity, result.quality, { connectivityWeight: 0.55 });

      planned.push({
        id: row.id,
        cycle_id: options.cycleId,
        service: this.deps.config.service,
        created_at: nowIso,
        passed: result.status === 'passed',
        status: result.status,
        http_status: result.http_status,
        latency_ms: result.latency_ms,
        reason: result.reason,
        details: result.details === null ? null : JSON.stringify(result.details),
        score,
        // A passing service verdict can lift a low-score proxy into the pool; it never evicts one.
        status_next: result.status === 'passed' ? 'active' : row.status,
      });
    }
    return planned;
  }

  /** Post-cycle sweeps, in the order that keeps the rolling pool stable. */
  async finalize(options: { cycleId: string; nowMs: number }): Promise<{
    expired: number;
    quarantined: number;
    demoted: number;
    released: number;
    pool_size: number;
  }> {
    const { proxies, config } = this.deps;
    const expired = await proxies.expireStale({
      ttlMinutes: config.pool.ttlMinutes,
      nowIso: isoNow(options.nowMs),
    });
    const quarantined = await proxies.quarantineFailures({
      maxConsecutiveFailures: config.pool.maxConsecutiveFailures,
    });
    const demoted = await proxies.enforcePoolCapacity(config.pool.maxActive);
    const released =
      (await proxies.releaseOrphanedPending(options.cycleId)) +
      (await proxies.releaseForeignPending(options.cycleId));
    const counts = await proxies.countByStatus();
    this.deps.logger.info('pool updated', {
      event: LOG_EVENTS.POOL_UPDATED,
      cycle_id: options.cycleId,
      expired,
      quarantined,
      demoted,
      released,
      pool_size: counts.active,
    });
    return { expired, quarantined, demoted, released, pool_size: counts.active };
  }
}
