/**
 * The refresh cycle: one pass of the whole pipeline, in the order the design specifies.
 *
 *   discover -> normalize -> dedupe -> connectivity validation -> authorized service compatibility
 *   check -> scoring -> pool add -> pool recheck -> quarantine/expiry -> statistics
 *
 * Every stage is bounded (per-cycle caps, concurrency limits, timeouts, retry caps) and a failing
 * stage never aborts the cycle: the failure is recorded on the cycle row and in the log.
 */

import {
  createLogger,
  dedupeKeyHash,
  endpointFromRecord,
  errorFields,
  isProxyEndpointAllowed,
  LOG_EVENTS,
  newCycleId,
  newJobId,
  type Logger,
} from '@proxypulse/shared';
import {
  META_KEYS,
  type CyclesRepository,
  type MetaRepository,
  type ProxiesRepository,
  type ProxyRow,
  type ServiceResultsRepository,
  type ValidationResultsRepository,
} from '@proxypulse/db';
import { serviceScore, type CrunchyrollChecker } from '@proxypulse/service-crunchyroll';

import type { WorkerConfig } from '../config.js';
import { DiscoveryService, type SourceOutcome } from '../discovery/service.js';
import { createProviders } from '../discovery/providers.js';
import { createRobotsGate, permissiveRobotsGate } from '../discovery/robots-gate.js';
import type { DirectFetcher } from '../net/direct-fetch.js';
import type { NodeProxyRequester } from '../net/proxy-client.js';
import { createJobQueue, type JobQueue, type ProxyJob } from '../queue/index.js';
import {
  type PoolManager,
  type ServiceStageResult,
  type ValidatedOutcome,
} from '../pool/manager.js';
import { type ValidationChecker } from '../validation/checker.js';

export interface CycleReport {
  cycle_id: string;
  status: 'completed' | 'failed';
  trigger: 'scheduler' | 'manual' | 'startup' | 'queue';
  started_at: string;
  finished_at: string;
  duration_ms: number;
  discovery: {
    sources: number;
    sources_ok: number;
    sources_failed: number;
    discovered: number;
    accepted: number;
    rejected: number;
    duplicates: number;
    blocked_by_policy: number;
    upserted: number;
    inserted: number;
  };
  validation: {
    queued: number;
    checked: number;
    passed: number;
    failed: number;
    added: number;
    retained: number;
  };
  service: {
    enabled: boolean;
    queued: number;
    checked: number;
    passed: number;
    blocked: number;
    failed: number;
    skipped: number;
  };
  pool: { size: number; expired: number; quarantined: number; demoted: number; released: number };
  error: string | null;
  per_source: SourceOutcome[];
}

export interface PipelineDeps {
  config: WorkerConfig;
  logger?: Logger;
  proxies: ProxiesRepository;
  cycles: CyclesRepository;
  meta: MetaRepository;
  validations: ValidationResultsRepository;
  serviceResults: ServiceResultsRepository;
  requester: NodeProxyRequester;
  checker: ValidationChecker;
  serviceChecker: CrunchyrollChecker;
  pool: PoolManager;
  queue?: JobQueue;
  direct: DirectFetcher;
  /** Base directory for `local-file` discovery sources (defaults to process.cwd()). */
  cwd?: string;
  now?: () => number;
}

export interface RunCycleOptions {
  cycleId?: string;
  trigger?: CycleReport['trigger'];
  signal?: AbortSignal;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function createPipeline(deps: PipelineDeps) {
  const logger = deps.logger ?? createLogger({ name: 'pipeline' });
  const queue =
    deps.queue ?? createJobQueue({ config: deps.config, logger: logger.child('queue') });
  const nowMs = deps.now ?? (() => Date.now());

  /** One gate for the process: per-origin decisions are cached (1 h) and shared by all sources. */
  const robots = deps.config.discovery.sources.some((source) => source.kind !== 'local-file')
    ? createRobotsGate({
        direct: deps.direct,
        userAgent: deps.config.discovery.userAgent,
        logger: logger.child('robots'),
      })
    : permissiveRobotsGate;

  const discovery = (cycleId: string) =>
    new DiscoveryService({
      providers: createProviders(deps.config.discovery.sources, logger.child('discovery')),
      concurrency: deps.config.discovery.concurrency,
      retries: deps.config.discovery.retries,
      backoffBaseMs: 500,
      candidateCap: deps.config.discovery.candidateCap,
      logger,
      context: {
        cycleId,
        cwd: deps.cwd ?? process.cwd(),
        fetchText: (url) => deps.direct.get(url),
        robots,
      },
    });

  async function runCycle(options: RunCycleOptions = {}): Promise<CycleReport> {
    const config = deps.config;
    const startedMs = nowMs();
    const cycleId = options.cycleId ?? newCycleId(new Date(startedMs));
    const startedAt = iso(startedMs);
    const cycleLogger = logger.child('cycle', { cycle_id: cycleId });
    const report: CycleReport = {
      cycle_id: cycleId,
      status: 'completed',
      trigger: options.trigger ?? 'manual',
      started_at: startedAt,
      finished_at: startedAt,
      duration_ms: 0,
      discovery: {
        sources: config.discovery.sources.filter((source) => source.enabled).length,
        sources_ok: 0,
        sources_failed: 0,
        discovered: 0,
        accepted: 0,
        rejected: 0,
        duplicates: 0,
        blocked_by_policy: 0,
        upserted: 0,
        inserted: 0,
      },
      validation: { queued: 0, checked: 0, passed: 0, failed: 0, added: 0, retained: 0 },
      service: {
        enabled: config.serviceCheck.enabled,
        queued: 0,
        checked: 0,
        passed: 0,
        blocked: 0,
        failed: 0,
        skipped: 0,
      },
      pool: { size: 0, expired: 0, quarantined: 0, demoted: 0, released: 0 },
      error: null,
      per_source: [],
    };

    await deps.cycles.start(cycleId, startedAt);
    await deps.meta.set(META_KEYS.currentCycleId, cycleId);
    cycleLogger.info('cycle started', {
      event: LOG_EVENTS.CYCLE_STARTED,
      trigger: report.trigger,
      sources: report.discovery.sources,
    });

    try {
      // ---------------------------------------------------------------- 1..3 discovery
      const discoveryRun = await discovery(cycleId).run();
      const policyAllowed = discoveryRun.candidates.filter(
        (candidate) =>
          isProxyEndpointAllowed(candidate.host, {
            allowPrivate: config.security.allowPrivateEndpoints,
          }).ok,
      );
      report.discovery.blocked_by_policy = discoveryRun.candidates.length - policyAllowed.length;
      if (report.discovery.blocked_by_policy > 0) {
        cycleLogger.warn('rejected discovered endpoints by network policy', {
          event: LOG_EVENTS.SSRF_BLOCKED,
          count: report.discovery.blocked_by_policy,
        });
      }
      report.discovery.discovered = discoveryRun.totals.discovered;
      report.discovery.accepted = policyAllowed.length;
      report.discovery.rejected = discoveryRun.totals.rejected;
      report.discovery.duplicates = discoveryRun.totals.duplicates;
      report.discovery.sources_ok = discoveryRun.totals.sources_ok;
      report.discovery.sources_failed = discoveryRun.totals.sources_failed;
      report.per_source = discoveryRun.per_source;

      const upsert = await deps.proxies.upsertCandidates(
        policyAllowed.map((proxy) => ({
          proxy,
          source: discoveryRun.sourceByDedupeKey.get(dedupeKeyHash(proxy)) ?? 'unknown',
        })),
        cycleId,
        iso(nowMs()),
      );
      report.discovery.upserted = upsert.total;
      report.discovery.inserted = upsert.inserted;

      // ------------------------------------------------------------ 4 validation queue
      const queueRows = await deps.proxies.selectValidationQueue({
        newLimit: config.pool.maxNewPerCycle,
        quarantineLimit: config.pool.maxQuarantineRecheckPerCycle,
        recheckLimit: config.pool.maxRecheckPerCycle,
        recheckAfterMinutes: config.pool.recheckAfterMinutes,
        nowIso: iso(nowMs()),
      });
      const rows = queueRows.slice(0, config.validation.maxPerCycle);
      const rowsById = new Map<number, ProxyRow>(rows.map((row) => [row.id, row]));
      report.validation.queued = rows.length;

      if (rows.length > 0) {
        await deps.proxies.markPending(
          rows.map((row) => row.id),
          cycleId,
        );

        const outcomes = new Map<number, ValidatedOutcome>();
        const jobs: ProxyJob[] = rows.map((row) => ({
          job_id: newJobId('val'),
          type: 'VALIDATE',
          cycle_id: cycleId,
          issued_at: iso(nowMs()),
          proxy_id: row.id,
        }));
        await queue.sendMany(jobs);
        const consumed = await queue.consume(
          async (job) => {
            if (job.type !== 'VALIDATE' || job.proxy_id === undefined) return;
            const row = rowsById.get(job.proxy_id);
            if (!row) return;
            const outcome = await deps.checker.validate(endpointFromRecord(row), {
              cycle_id: cycleId,
              proxy_id: row.id,
            });
            outcomes.set(row.id, { proxy_id: row.id, outcome });
          },
          {
            concurrency: config.validation.concurrency,
            drainOnly: true,
            // twice the produced count leaves room for in-drain retries; the loop still stops when empty
            maxJobs: jobs.length * 2,
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
        void consumed;

        const plan = deps.pool.planValidation(rows, [...outcomes.values()], {
          cycleId,
          nowMs: nowMs(),
          trustByDedupeKey: discoveryRun.trustByDedupeKey,
        });
        await deps.proxies.persistValidationOutcomes(plan.updates);
        report.validation.checked = plan.tally.checked;
        report.validation.passed = plan.tally.passed;
        report.validation.failed = plan.tally.failed;
        report.validation.added = plan.tally.added;
        report.validation.retained = plan.tally.retained;
      }

      // ------------------------------------------- 5 authorized service compatibility checks
      const serviceBudget = config.serviceCheck.enabled ? config.serviceCheck.maxChecksPerCycle : 0;
      if (serviceBudget > 0) {
        deps.serviceChecker.beginCycle(cycleId);
        const passedRows = await deps.proxies.getByIds([...rowsById.keys()]);
        const fresh = passedRows
          .filter(
            (row) =>
              row.validation_status === 'passed' && row.score >= config.serviceCheck.minScore,
          )
          .filter((row) => row.service_status !== 'passed')
          .sort((a, b) => b.score - a.score)
          .slice(0, serviceBudget);
        const stalePool = await deps.proxies.selectServiceCandidates({
          limit: Math.max(0, serviceBudget - fresh.length),
          minScore: config.serviceCheck.minScore,
          recheckAfterMinutes: config.serviceCheck.recheckAfterMinutes,
          nowIso: iso(nowMs()),
        });
        const seen = new Set<number>(fresh.map((row) => row.id));
        const candidates = [...fresh, ...stalePool.filter((row) => !seen.has(row.id))].slice(
          0,
          serviceBudget,
        );
        report.service.queued = candidates.length;

        if (candidates.length > 0) {
          const byId = new Map(candidates.map((row) => [row.id, row]));
          const results = new Map<number, ServiceStageResult>();
          const serviceJobs: ProxyJob[] = candidates.map((row) => ({
            job_id: newJobId('svc'),
            type: 'SERVICE_CHECK',
            cycle_id: cycleId,
            issued_at: iso(nowMs()),
            proxy_id: row.id,
          }));
          await queue.sendMany(serviceJobs);
          await queue.consume(
            async (job) => {
              if (job.type !== 'SERVICE_CHECK' || job.proxy_id === undefined) return;
              const row = byId.get(job.proxy_id);
              if (!row) return;
              const result = await deps.serviceChecker.check(endpointFromRecord(row), {
                proxy_id: row.id,
                cycle_id: cycleId,
              });
              const quality = serviceScore({
                verdict: result.verdict,
                latencyMs: result.latency_ms,
                consecutiveServiceFailures: row.service_status === 'failed' ? 1 : 0,
              });
              results.set(row.id, {
                proxy_id: row.id,
                status: result.status,
                latency_ms: result.latency_ms,
                http_status: result.http_status,
                reason: result.reason,
                // Only a small allow-listed summary is persisted.
                details: {
                  verdict: result.verdict,
                  robots_allowed: result.robots.allowed,
                  ...(result.details ?? {}),
                },
                quality: result.verdict === 'skipped' ? null : quality.quality,
              });
            },
            {
              // One at a time: the adapter's own spacing + token bucket define the real rate.
              concurrency: 1,
              drainOnly: true,
              maxJobs: serviceJobs.length * 2,
              ...(options.signal ? { signal: options.signal } : {}),
            },
          );

          const planned = deps.pool.planService(candidates, [...results.values()], {
            cycleId,
            nowMs: nowMs(),
          });
          await deps.proxies.persistServiceOutcomes(config.service, planned);
          for (const result of results.values()) {
            report.service.checked += 1;
            if (result.status === 'passed') report.service.passed += 1;
            else if (result.status === 'blocked') report.service.blocked += 1;
            else if (result.status === 'failed') report.service.failed += 1;
            else report.service.skipped += 1;
          }
        }
      } else {
        cycleLogger.info('service compatibility checks disabled', {
          event: LOG_EVENTS.SERVICE_CHECK_SKIPPED,
        });
      }

      // ---------------------------------------------------- 7..9 pool maintenance sweeps
      const finalize = await deps.pool.finalize({ cycleId, nowMs: nowMs() });
      report.pool = {
        size: finalize.pool_size,
        expired: finalize.expired,
        quarantined: finalize.quarantined,
        demoted: finalize.demoted,
        released: finalize.released,
      };

      // ------------------------------------------------------------------- 10 statistics
      const stats = await deps.proxies.stats({
        ttlMinutes: config.pool.ttlMinutes,
        service: config.service,
        requireServicePass: config.pool.requireServicePass,
        nowIso: iso(nowMs()),
      });
      await deps.meta.setJson(META_KEYS.statsSnapshot, { ...stats, computed_at: iso(nowMs()) });
      report.finished_at = iso(nowMs());
      report.duration_ms = nowMs() - startedMs;

      await deps.cycles.complete(cycleId, {
        finished_at: report.finished_at,
        candidates_discovered: report.discovery.discovered,
        candidates_new: report.discovery.inserted,
        candidates_checked: report.validation.checked,
        candidates_passed: report.validation.passed,
        candidates_failed: report.validation.failed,
        service_checked: report.service.checked,
        service_passed: report.service.passed,
        pool_size: report.pool.size,
        pool_added: report.validation.added,
        pool_quarantined: report.pool.quarantined,
        pool_expired: report.pool.expired,
        duration_ms: report.duration_ms,
        error: null,
      });
      await deps.meta.set(META_KEYS.lastCompletedCycleId, cycleId);
      await deps.meta.remove(META_KEYS.lastCycleError);
      await deps.meta.set(
        META_KEYS.nextRunAt,
        iso(startedMs + config.refresh.intervalMinutes * 60_000),
      );

      await maintenanceIfNeeded();

      cycleLogger.info('cycle completed', {
        event: LOG_EVENTS.CYCLE_COMPLETED,
        duration_ms: report.duration_ms,
        discovered: report.discovery.discovered,
        checked: report.validation.checked,
        passed: report.validation.passed,
        service_passed: report.service.passed,
        pool_size: report.pool.size,
      });
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.status = 'failed';
      report.error = message.slice(0, 300);
      report.finished_at = iso(nowMs());
      report.duration_ms = nowMs() - startedMs;
      cycleLogger.error('cycle failed', { event: LOG_EVENTS.CYCLE_FAILED, ...errorFields(error) });
      await deps.cycles
        .fail(cycleId, report.finished_at, message, report.duration_ms)
        .catch(() => undefined);
      await deps.meta.set(META_KEYS.lastCycleError, message.slice(0, 300)).catch(() => undefined);
      await deps.proxies.releaseOrphanedPending(cycleId).catch(() => undefined);
      return report;
    } finally {
      await deps.meta.remove(META_KEYS.currentCycleId).catch(() => undefined);
      cycleLogger.debug('cycle finished', { cycle_id: cycleId, status: report.status });
    }
  }

  /** Nightly housekeeping so the database cannot grow without bound. */
  async function maintenanceIfNeeded(): Promise<void> {
    const lastPrune = await deps.meta.get(META_KEYS.lastPruneAt);
    const ageMs = lastPrune ? nowMs() - Date.parse(lastPrune) : Number.POSITIVE_INFINITY;
    if (ageMs < 24 * 60 * 60 * 1000) return;
    const pruned = await deps.proxies.pruneHistory({
      resultRetentionDays: deps.config.retention.resultDays,
      deadProxyRetentionDays: deps.config.retention.deadProxyDays,
      cycleRetentionDays: deps.config.retention.cycleDays,
      nowIso: iso(nowMs()),
    });
    await deps.meta.set(META_KEYS.lastPruneAt, iso(nowMs()));
    cycleInfo('history pruned', pruned);
  }

  const cycleInfo = (message: string, fields: Record<string, unknown>): void => {
    logger.info(message, { event: LOG_EVENTS.STATS_UPDATED, ...fields });
  };

  /** Handles a job that arrived from outside (Cloudflare queue) instead of from this cycle. */
  async function handleExternalJob(job: ProxyJob): Promise<void> {
    const cycleId = job.cycle_id;
    switch (job.type) {
      case 'DISCOVER':
      case 'POOL_UPDATE':
      case 'STATS_UPDATE':
        await runCycle({ cycleId, trigger: 'queue' });
        return;
      case 'VALIDATE':
      case 'RECHECK':
      case 'SERVICE_CHECK': {
        if (job.proxy_id === undefined) throw new Error('job is missing proxy_id');
        const [row] = await deps.proxies.getByIds([job.proxy_id]);
        if (!row) throw new Error(`unknown proxy ${job.proxy_id}`);
        const endpoint = endpointFromRecord(row);
        const outcome = await deps.checker.validate(endpoint, {
          cycle_id: cycleId,
          proxy_id: row.id,
        });
        const plan = deps.pool.planValidation([row], [{ proxy_id: row.id, outcome }], {
          cycleId,
          nowMs: nowMs(),
          trustByDedupeKey: new Map(),
        });
        await deps.proxies.persistValidationOutcomes(plan.updates);
        if (job.type === 'SERVICE_CHECK' || (job.type === 'RECHECK' && outcome.reachable)) {
          if (!configEnabledService()) return;
          const result = await deps.serviceChecker.check(endpoint, {
            proxy_id: row.id,
            cycle_id: cycleId,
          });
          const quality = serviceScore({
            verdict: result.verdict,
            latencyMs: result.latency_ms,
            consecutiveServiceFailures: 0,
          });
          const planned = deps.pool.planService(
            [row],
            [
              {
                proxy_id: row.id,
                status: result.status,
                latency_ms: result.latency_ms,
                http_status: result.http_status,
                reason: result.reason,
                details: { verdict: result.verdict, source: 'queue' },
                quality: result.verdict === 'skipped' ? null : quality.quality,
              },
            ],
            { cycleId, nowMs: nowMs() },
          );
          await deps.proxies.persistServiceOutcomes(deps.config.service, planned);
        }
        return;
      }
      default:
        throw new Error(`unsupported job type`);
    }
  }

  const configEnabledService = (): boolean => deps.config.serviceCheck.enabled;

  return { runCycle, handleExternalJob, queue };
}

export type Pipeline = ReturnType<typeof createPipeline>;
