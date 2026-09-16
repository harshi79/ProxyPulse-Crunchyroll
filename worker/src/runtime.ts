/**
 * Composition root for the worker. Everything the process needs is assembled here — config, database,
 * repositories, network layer, validators, the service adapter, the queue, the pipeline, the scheduler
 * and the internal HTTP API — so that `src/index.ts` (long running), `bin/run-cycle.ts` (one cycle) and
 * the tests differ only in the options they pass.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Server } from 'node:http';

import { createLogger, LOG_EVENTS, newJobId, redactUrl, type Logger } from '@proxypulse/shared';
import {
  applyMigrations,
  createDb,
  CyclesRepository,
  type DbHandle,
  MetaRepository,
  ProxiesRepository,
  ServiceResultsRepository,
  ValidationResultsRepository,
} from '@proxypulse/db';
import {
  CrunchyrollChecker,
  DEFAULT_CRUNCHYROLL_CONFIG,
  SERVICE_NAME,
  type CrunchyrollCheckConfig,
  type DirectFetcher as ServiceDirectFetcher,
} from '@proxypulse/service-crunchyroll';

import { configWarnings, loadConfig, type WorkerConfig } from './config.js';
import { DirectFetcher } from './net/direct-fetch.js';
import { NodeProxyRequester } from './net/proxy-client.js';
import { ValidationChecker } from './validation/checker.js';
import { PoolManager } from './pool/manager.js';
import { createJobQueue, isProxyJob, type JobQueue, type ProxyJob } from './queue/index.js';
import { createPipeline, type Pipeline } from './pipeline/cycle.js';
import { RefreshScheduler } from './pipeline/scheduler.js';
import { createWorkerServer, type HttpDeps } from './http/server.js';
import type { ViewContext } from './views.js';

export interface RuntimeOptions {
  config?: WorkerConfig;
  env?: NodeJS.ProcessEnv;
  /** Base directory used for relative config paths and for `local-file` discovery sources. */
  cwd?: string;
  logger?: Logger;
  /** Injected in tests and the local demo; otherwise a client is created from the config. */
  db?: DbHandle;
  /** Applied on boot when true (default). Tests that provide their own schema set false. */
  migrate?: boolean;
  migrationsDir?: string;
  startHttp?: boolean;
  startScheduler?: boolean;
  version?: string;
  now?: () => number;
}

export interface WorkerRuntime {
  config: WorkerConfig;
  logger: Logger;
  db: DbHandle;
  ownsDb: boolean;
  proxies: ProxiesRepository;
  cycles: CyclesRepository;
  meta: MetaRepository;
  validations: ValidationResultsRepository;
  serviceResults: ServiceResultsRepository;
  queue: JobQueue;
  pipeline: Pipeline;
  scheduler: RefreshScheduler;
  serviceChecker: CrunchyrollChecker;
  views: ViewContext;
  server: Server | null;
  /** Runs one full cycle and returns its report. */
  runCycle: (options?: {
    trigger?: 'scheduler' | 'startup' | 'manual';
  }) => Promise<Awaited<ReturnType<Pipeline['runCycle']>>>;
  /** Enqueues one job (used by POST /internal/jobs and by tests). */
  submitJob: (input: unknown) => Promise<{ accepted: boolean; job_id?: string; error?: string }>;
  listen: (port?: number, host?: string) => Promise<{ port: number }>;
  stop: () => Promise<void>;
}

const SHUTDOWN_GRACE_MS = 25_000;

/** `file:./data/x.db` should not fail because the folder does not exist yet. */
function ensureLocalDatabaseParent(url: string, cwd: string): void {
  if (!url.startsWith('file:')) return;
  const path = url.slice('file:'.length);
  if (path.length === 0 || path === ':memory:') return;
  const absolute = path.startsWith('/') ? path : resolve(cwd, path);
  try {
    mkdirSync(dirname(absolute), { recursive: true });
  } catch {
    /* a permission problem will surface from the connection attempt itself, with a better message */
  }
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<WorkerRuntime> {
  const config =
    options.config ?? loadConfig({ env: options.env ?? process.env, cwd: options.cwd });
  const logger =
    options.logger ??
    createLogger({
      name: 'worker',
      level: config.logLevel,
      base: { environment: config.environment },
      ...(options.now ? { now: options.now } : {}),
    });
  const now = options.now ?? (() => Date.now());
  const version = options.version ?? '0.1.0';

  const ownsDb = options.db === undefined;
  if (ownsDb) ensureLocalDatabaseParent(config.db.url, options.cwd ?? process.cwd());
  const db = options.db ?? createDb({ url: config.db.url, authToken: config.db.authToken });

  if (options.migrate !== false) {
    const result = await applyMigrations(db, {
      ...(options.migrationsDir ? { dir: options.migrationsDir } : {}),
      logger: logger.child('migrations'),
    });
    logger.info('database ready', {
      event: LOG_EVENTS.DB_MIGRATION_APPLIED,
      database: redactUrl(db.url),
      applied: result.applied.length,
      already_applied: result.already_applied.length,
    });
  }

  const proxies = new ProxiesRepository(db);
  const cycles = new CyclesRepository(db);
  const meta = new MetaRepository(db);
  const validations = new ValidationResultsRepository(db);
  const serviceResults = new ServiceResultsRepository(db);

  // Two separate requesters on purpose: the validator may reach any public check endpoint, while the
  // service adapter gets a client that is hard-restricted to the authorised service hosts.
  const requester = new NodeProxyRequester({
    connectTimeoutMs: config.validation.connectTimeoutMs,
    timeoutMs: config.validation.timeoutMs,
    maxResponseBytes: config.validation.maxResponseBytes,
    allowPrivateEndpoints: config.security.allowPrivateEndpoints,
    dnsCacheTtlMs: config.security.dnsCacheTtlMs,
  });
  const serviceRequester = new NodeProxyRequester({
    connectTimeoutMs: config.validation.connectTimeoutMs,
    timeoutMs: config.serviceCheck.timeoutMs,
    maxResponseBytes: 64 * 1024,
    allowPrivateEndpoints: config.security.allowPrivateEndpoints,
    dnsCacheTtlMs: config.security.dnsCacheTtlMs,
    allowedTargetHosts: config.serviceCheck.allowedHosts,
  });

  const direct = new DirectFetcher({
    timeoutMs: config.discovery.timeoutMs,
    maxBytes: config.discovery.maxResponseBytes,
    headers: { 'user-agent': config.discovery.userAgent },
    allowPrivate: config.security.allowPrivateEndpoints,
    maxRedirects: 3,
    dnsCacheTtlMs: config.security.dnsCacheTtlMs,
  });

  /** robots.txt (and nothing else) is fetched directly, with the adapter's own timeout. */
  const serviceDirect: ServiceDirectFetcher = async (url) => {
    const result = await direct.get(url);
    return {
      status: result.status,
      text: result.text,
      ...(result.error ? { error: `${result.error.code}: ${result.error.message}` } : {}),
    };
  };

  const checker = new ValidationChecker({
    requester,
    logger: logger.child('validation'),
    config: {
      concurrency: config.validation.concurrency,
      timeoutMs: config.validation.timeoutMs,
      retries: config.validation.retries,
      backoffBaseMs: config.validation.backoffBaseMs,
      maxResponseBytes: config.validation.maxResponseBytes,
      checkUrl: config.validation.checkUrl,
      successStatuses: config.validation.successStatuses,
      requireEgressEcho: config.validation.requireEgressEcho,
      rejectLocalEgress: config.validation.requireEgressEcho,
    },
  });

  const serviceConfig: CrunchyrollCheckConfig = {
    ...DEFAULT_CRUNCHYROLL_CONFIG,
    service: SERVICE_NAME,
    enabled: config.serviceCheck.enabled,
    checkPath: config.serviceCheck.checkPath,
    scheme: config.serviceCheck.scheme,
    checkUrl: config.serviceCheck.checkUrl,
    allowedHosts: config.serviceCheck.allowedHosts,
    userAgent: config.serviceCheck.userAgent,
    timeoutMs: config.serviceCheck.timeoutMs,
    rateLimitPerMinute: config.serviceCheck.rateLimitPerMinute,
    maxChecksPerCycle: config.serviceCheck.maxChecksPerCycle,
    minRequestSpacingMs: config.serviceCheck.minRequestSpacingMs,
    respectRobots: config.serviceCheck.respectRobots,
    minScoreForServiceCheck: config.serviceCheck.minScore,
  };
  const serviceChecker = new CrunchyrollChecker({
    requester: serviceRequester,
    direct: serviceDirect,
    config: serviceConfig,
    logger: logger.child('service'),
    now,
  });

  const pool = new PoolManager({ proxies, config, logger: logger.child('pool') });
  const queue = createJobQueue({ config, logger: logger.child('queue') });
  const pipeline = createPipeline({
    config,
    logger: logger.child('pipeline'),
    proxies,
    cycles,
    meta,
    validations,
    serviceResults,
    requester,
    checker,
    serviceChecker,
    pool,
    queue,
    direct,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    now,
  });

  const scheduler = new RefreshScheduler({
    intervalMinutes: config.refresh.intervalMinutes,
    runOnStartup: config.refresh.runOnStartup,
    jitterSeconds: config.refresh.jitterSeconds,
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    logger: logger.child('scheduler'),
    meta,
    runCycle: (runOptions) => pipeline.runCycle(runOptions),
  });

  const views: ViewContext = {
    config,
    proxies,
    cycles,
    meta,
    serviceResults,
    validations,
    schedulerStatus: () => scheduler.status(),
    serviceCheckerStats: () => serviceChecker.stats,
    version,
    now,
    dbPing: () => db.ping(),
  };

  /** Normalises an untrusted job body into a validated queue payload. */
  async function submitJob(
    input: unknown,
  ): Promise<{ accepted: boolean; job_id?: string; error?: string }> {
    const raw = (input ?? {}) as Record<string, unknown>;
    const current = await cycles.current();
    const candidate: unknown = {
      job_id: typeof raw.job_id === 'string' ? raw.job_id : newJobId(),
      type: raw.type,
      cycle_id:
        typeof raw.cycle_id === 'string' && raw.cycle_id.length > 0
          ? raw.cycle_id
          : (current?.cycle_id ?? `manual-${new Date(now()).toISOString()}`),
      issued_at: new Date(now()).toISOString(),
      ...(typeof raw.proxy_id === 'number' ? { proxy_id: raw.proxy_id } : {}),
      ...(raw.reason === 'new' ||
      raw.reason === 'recheck' ||
      raw.reason === 'revive' ||
      raw.reason === 'manual' ||
      raw.reason === 'stale_service'
        ? { reason: raw.reason }
        : {}),
    };
    if (!isProxyJob(candidate))
      return { accepted: false, error: 'job must be {type, proxy_id?} with a known type' };
    if (
      (candidate.type === 'VALIDATE' ||
        candidate.type === 'RECHECK' ||
        candidate.type === 'SERVICE_CHECK') &&
      candidate.proxy_id === undefined
    ) {
      return { accepted: false, error: `${candidate.type} requires a numeric proxy_id` };
    }
    const sent = await queue.send(candidate);
    if (!sent) return { accepted: false, error: 'queue rejected the job (full or closed)' };
    // Drain the queue right away so an operator does not have to wait for the next cycle — but never
    // while a cycle owns the queue, otherwise we would fight over the same jobs.
    const job: ProxyJob = candidate;
    if (scheduler.status().running) {
      logger.info('manual job queued behind a running cycle', {
        event: LOG_EVENTS.QUEUE_JOB_ENQUEUED,
        job_id: job.job_id,
      });
    } else {
      void queue
        .consume(
          async (queued) => {
            await pipeline.handleExternalJob(queued);
          },
          { concurrency: 1, drainOnly: true, maxJobs: 8 },
        )
        .catch((error: unknown) => {
          logger.warn('manual job failed', {
            event: LOG_EVENTS.QUEUE_JOB_FAILED,
            job_id: job.job_id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    return { accepted: true, job_id: job.job_id };
  }

  let http: { server: Server; stop: () => Promise<void> } | null = null;
  if (options.startHttp === true) {
    const httpDeps: HttpDeps = {
      config,
      logger: logger.child('http'),
      views,
      runCycle: async ({ wait = false }) => {
        if (wait) {
          const report = await scheduler.runOnce('manual');
          return { started: report !== null, cycle_id: report?.cycle_id ?? null };
        }
        if (scheduler.status().running) return { started: false };
        void scheduler.runOnce('manual');
        return { started: true };
      },
      status: () => scheduler.status(),
      ready: async () => (await db.ping()).ok,
      version,
      enqueueJob: submitJob,
    };
    http = createWorkerServer(httpDeps);
  }

  async function listen(port?: number, host?: string): Promise<{ port: number }> {
    if (!http) throw new Error('runtime created without startHttp');
    const wantPort = port ?? config.port;
    const wantHost = host ?? config.host;
    await new Promise<void>((resolve, reject) => {
      const server = http?.server;
      if (!server) return reject(new Error('no server'));
      server.once('error', reject);
      server.listen(wantPort, wantHost, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = http.server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : wantPort;
    logger.info('internal api listening', {
      event: LOG_EVENTS.HTTP_LISTENING,
      host: wantHost,
      port: bound,
    });
    return { port: bound };
  }

  async function stop(): Promise<void> {
    logger.info('worker stopping', { event: LOG_EVENTS.WORKER_STOPPING });
    await scheduler.stop();
    await queue.close().catch(() => undefined);
    if (http) await http.stop();
    if (ownsDb) db.close();
  }

  for (const warning of configWarnings(config))
    logger.warn(warning, { event: LOG_EVENTS.CONFIG_WARNING });

  return {
    config,
    logger,
    db,
    ownsDb,
    proxies,
    cycles,
    meta,
    validations,
    serviceResults,
    queue,
    pipeline,
    scheduler,
    serviceChecker,
    views,
    server: http?.server ?? null,
    runCycle: (runOptions = {}) => pipeline.runCycle({ trigger: runOptions.trigger ?? 'manual' }),
    submitJob,
    listen,
    stop,
  };
}

export type { WorkerConfig };
