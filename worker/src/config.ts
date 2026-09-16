/**
 * Worker configuration. Everything comes from the environment (see .env.example) with safe,
 * conservative defaults. Invalid configuration fails fast at startup instead of silently degrading.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createLogger,
  DEFAULT_SCORING_CONFIG,
  levelFromEnv,
  type LogLevel,
  type ProxyProtocol,
  redactText,
  redactUrl,
} from '@proxypulse/shared';

export const REFRESH_INTERVAL_MINUTES_DEFAULT = 15;

export type SourceKind = 'http-list' | 'json-endpoint' | 'local-file';

export interface SourceConfig {
  id: string;
  kind: SourceKind;
  enabled: boolean;
  /** URL for http-list / json-endpoint. */
  url?: string;
  /** Path (relative to cwd) for local-file sources; used by demos, tests and private seed files. */
  path?: string;
  /** Protocol assumed for entries without an explicit scheme. */
  protocol?: ProxyProtocol;
  /** For json-endpoint: dot path to the array (e.g. "data.proxies"). */
  itemsPath?: string;
  /** For json-endpoint: field names to read, in priority order. */
  fields?: {
    endpoint?: string[];
    host?: string[];
    protocol?: string[];
    port?: string[];
    country?: string[];
    anonymity?: string[];
    username?: string[];
    password?: string[];
  };
  maxEntries?: number;
  /** When false the source is fetched without consulting robots.txt (only for hosts you own). */
  respectRobots?: boolean;
  /** Relative reliability of this source (0..1), used by scoring. */
  trust?: number;
  note?: string;
}

export interface WorkerConfig {
  environment: 'development' | 'production' | 'test';
  service: string;
  host: string;
  port: number;
  logLevel: LogLevel;
  db: { url: string; authToken: string | undefined; migrationsDir: string | undefined };
  internalApiToken: string;
  refresh: {
    intervalMinutes: number;
    runOnStartup: boolean;
    jitterSeconds: number;
  };
  discovery: {
    sources: SourceConfig[];
    concurrency: number;
    timeoutMs: number;
    /** Total attempts per source (1 = no retry). */
    retries: number;
    maxResponseBytes: number;
    candidateCap: number;
    userAgent: string;
  };
  validation: {
    concurrency: number;
    timeoutMs: number;
    connectTimeoutMs: number;
    /** Total attempts per proxy (1 = no retry); only transient errors are retried. */
    retries: number;
    backoffBaseMs: number;
    maxResponseBytes: number;
    /** Endpoint fetched *through* the proxy to prove it forwards traffic. */
    checkUrl: string;
    /** Extra success statuses (besides 2xx/3xx) accepted from the check endpoint. */
    successStatuses: number[];
    /** Require the check response to echo the proxy's egress address. */
    requireEgressEcho: boolean;
    maxPerCycle: number;
  };
  pool: {
    minScore: number;
    ttlMinutes: number;
    maxConsecutiveFailures: number;
    maxActive: number;
    recheckAfterMinutes: number;
    maxNewPerCycle: number;
    maxRecheckPerCycle: number;
    maxQuarantineRecheckPerCycle: number;
    requireServicePass: boolean;
    idealLatencyMs: number;
    maxLatencyMs: number;
  };
  serviceCheck: {
    enabled: boolean;
    checkPath: string;
    scheme: 'https' | 'http';
    checkUrl?: string;
    rateLimitPerMinute: number;
    maxChecksPerCycle: number;
    minRequestSpacingMs: number;
    timeoutMs: number;
    respectRobots: boolean;
    userAgent: string;
    allowRetestBlocked: boolean;
    recheckAfterMinutes: number;
    minScore: number;
    allowedHosts: string[];
  };
  security: {
    /** Dev/test only: permits proxy endpoints and check URLs on private/loopback addresses. */
    allowPrivateEndpoints: boolean;
    maxRequestBytes: number;
    dnsCacheTtlMs: number;
  };
  queue: {
    driver: 'memory' | 'cloudflare';
    concurrency: number;
    memory: { capacity: number };
    cloudflare: {
      accountId: string;
      queueId: string;
      apiToken: string;
      batchSize: number;
      pollSeconds: number;
      visibilityTimeoutMs: number;
      maxRetries: number;
    } | null;
  };
  retention: { resultDays: number; deadProxyDays: number; cycleDays: number };
  scoring: typeof DEFAULT_SCORING_CONFIG;
}

class ConfigError extends Error {}

const readString = (env: NodeJS.ProcessEnv, name: string, fallback: string): string => {
  const value = env[name];
  return value === undefined || value.trim().length === 0 ? fallback : value.trim();
};

const readOptional = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
};

const readInt = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConfigError(`${name} must be an integer (got "${raw}")`);
  }
  if (value < min || value > max)
    throw new ConfigError(`${name} must be between ${min} and ${max} (got ${value})`);
  return value;
};

const readBool = (env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean => {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new ConfigError(`${name} must be a boolean (got "${raw}")`);
};

const readList = (env: NodeJS.ProcessEnv, name: string, fallback: string[]): string[] => {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const readJson = <T>(env: NodeJS.ProcessEnv, name: string): T | undefined => {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new ConfigError(
      `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const DEFAULT_SOURCE_FILENAMES = ['config/sources.json', 'sources.json'];

export function loadSourceConfigs(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): SourceConfig[] {
  const inline = readJson<SourceConfig[]>(env, 'PROXY_SOURCES_JSON');
  if (inline) return normalizeSources(inline);

  const explicitFile = readOptional(env, 'PROXY_SOURCES_FILE');
  const candidates = explicitFile
    ? [resolve(cwd, explicitFile)]
    : DEFAULT_SOURCE_FILENAMES.map((file) => resolve(cwd, file));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : ((parsed as { sources?: unknown[] })?.sources ?? []);
      return normalizeSources(list as SourceConfig[]);
    } catch (error) {
      throw new ConfigError(
        `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return [];
}

function normalizeSources(list: readonly SourceConfig[]): SourceConfig[] {
  const kinds: SourceKind[] = ['http-list', 'json-endpoint', 'local-file'];
  const seen = new Set<string>();
  return list.map((source, index) => {
    if (!source || typeof source !== 'object')
      throw new ConfigError(`sources[${index}] is not an object`);
    const id = (source.id ?? '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) {
      throw new ConfigError(
        `sources[${index}].id must match /^[a-z0-9][a-z0-9._-]{1,63}$/ (got "${id}")`,
      );
    }
    if (seen.has(id)) throw new ConfigError(`duplicate source id "${id}"`);
    seen.add(id);
    if (!kinds.includes(source.kind))
      throw new ConfigError(`source "${id}" has unknown kind "${source.kind}"`);
    if (source.kind === 'local-file') {
      if (!source.path) throw new ConfigError(`source "${id}" requires a path`);
      if (source.path.includes('..'))
        throw new ConfigError(`source "${id}" path must not traverse outside the repo`);
    } else if (!source.url) {
      throw new ConfigError(`source "${id}" requires a url`);
    }
    if (
      source.protocol !== undefined &&
      !['http', 'https', 'socks4', 'socks5'].includes(source.protocol)
    ) {
      throw new ConfigError(`source "${id}" has an invalid protocol hint`);
    }
    return { ...source, enabled: source.enabled !== false };
  });
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): WorkerConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const environment = readString(env, 'ENVIRONMENT', 'development') as WorkerConfig['environment'];
  if (!['development', 'production', 'test'].includes(environment)) {
    throw new ConfigError(
      `ENVIRONMENT must be development | production | test (got "${environment}")`,
    );
  }

  const internalApiToken = readString(env, 'INTERNAL_API_TOKEN', '');
  if (environment === 'production' && internalApiToken.length < 16) {
    throw new ConfigError('INTERNAL_API_TOKEN must be at least 16 characters in production');
  }

  const allowPrivateEndpoints = readBool(
    env,
    'ALLOW_PRIVATE_ENDPOINTS',
    environment !== 'production',
  );
  const checkUrl = readString(env, 'VALIDATION_CHECK_URL', 'https://www.gstatic.com/generate_204');
  const sources = loadSourceConfigs(env, cwd);
  const dbUrlRaw = readString(env, 'DATABASE_URL', 'file:./data/proxypulse.db');
  const dbUrl = dbUrlRaw.startsWith('file:./')
    ? `file:${resolve(cwd, dbUrlRaw.slice('file:./'.length))}`
    : dbUrlRaw;

  const serviceScheme = readString(env, 'CR_CHECK_SCHEME', 'https') as 'https' | 'http';
  if (!['https', 'http'].includes(serviceScheme))
    throw new ConfigError('CR_CHECK_SCHEME must be https or http');

  const queueDriver = readString(env, 'QUEUE_DRIVER', 'memory') as 'memory' | 'cloudflare';
  if (!['memory', 'cloudflare'].includes(queueDriver))
    throw new ConfigError('QUEUE_DRIVER must be memory or cloudflare');
  const cloudflareAccount = readOptional(env, 'CLOUDFLARE_ACCOUNT_ID');
  const cloudflareQueueId = readOptional(env, 'CLOUDFLARE_QUEUE_ID');
  const cloudflareToken = readOptional(env, 'CLOUDFLARE_QUEUES_TOKEN');
  const cloudflareQueue =
    queueDriver === 'cloudflare'
      ? {
          accountId: cloudflareAccount ?? '',
          queueId: cloudflareQueueId ?? '',
          apiToken: cloudflareToken ?? '',
          batchSize: readInt(env, 'QUEUE_BATCH_SIZE', 16, 1, 100),
          pollSeconds: readInt(env, 'QUEUE_POLL_SECONDS', 20, 1, 60),
          visibilityTimeoutMs: readInt(env, 'QUEUE_VISIBILITY_TIMEOUT_MS', 60_000, 1_000, 400_000),
          maxRetries: readInt(env, 'QUEUE_MAX_RETRIES', 2, 0, 10),
        }
      : null;
  if (
    queueDriver === 'cloudflare' &&
    cloudflareQueue &&
    (!cloudflareQueue.accountId || !cloudflareQueue.queueId || !cloudflareQueue.apiToken)
  ) {
    throw new ConfigError(
      'QUEUE_DRIVER=cloudflare requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_QUEUE_ID and CLOUDFLARE_QUEUES_TOKEN',
    );
  }

  const config: WorkerConfig = {
    environment,
    service: readString(env, 'SERVICE_NAME', 'crunchyroll'),
    host: readString(env, 'HOST', '0.0.0.0'),
    port: readInt(env, 'PORT', 8080, 1, 65_535),
    logLevel: levelFromEnv(
      readOptional(env, 'LOG_LEVEL'),
      environment === 'production' ? 'info' : 'debug',
    ),
    db: {
      url: dbUrl,
      authToken: readOptional(env, 'DATABASE_AUTH_TOKEN'),
      migrationsDir: readOptional(env, 'DATABASE_MIGRATIONS_DIR'),
    },
    internalApiToken,
    refresh: {
      intervalMinutes: readInt(
        env,
        'REFRESH_INTERVAL_MINUTES',
        REFRESH_INTERVAL_MINUTES_DEFAULT,
        1,
        24 * 60,
      ),
      runOnStartup: readBool(env, 'RUN_CYCLE_ON_STARTUP', true),
      jitterSeconds: readInt(env, 'REFRESH_JITTER_SECONDS', 20, 0, 300),
    },
    discovery: {
      sources,
      concurrency: readInt(env, 'DISCOVERY_CONCURRENCY', 4, 1, 16),
      timeoutMs: readInt(env, 'DISCOVERY_TIMEOUT_MS', 15_000, 500, 60_000),
      retries: readInt(env, 'DISCOVERY_RETRIES', 2, 1, 5),
      maxResponseBytes: readInt(
        env,
        'DISCOVERY_MAX_BYTES',
        8 * 1024 * 1024,
        1_024,
        64 * 1024 * 1024,
      ),
      candidateCap: readInt(env, 'DISCOVERY_CANDIDATE_CAP', 20_000, 10, 500_000),
      userAgent: readString(
        env,
        'DISCOVERY_USER_AGENT',
        'ProxyPulseBot/1.0 (+https://github.com/harshi79/ProxyPulse-Crunchyroll)',
      ),
    },
    validation: {
      concurrency: readInt(env, 'VALIDATION_CONCURRENCY', 24, 1, 256),
      timeoutMs: readInt(env, 'VALIDATION_TIMEOUT_MS', 8_000, 250, 60_000),
      connectTimeoutMs: readInt(env, 'VALIDATION_CONNECT_TIMEOUT_MS', 5_000, 200, 30_000),
      retries: readInt(env, 'VALIDATION_RETRIES', 2, 1, 5),
      backoffBaseMs: readInt(env, 'VALIDATION_BACKOFF_MS', 400, 0, 10_000),
      maxResponseBytes: readInt(env, 'VALIDATION_MAX_BYTES', 64 * 1024, 512, 4 * 1024 * 1024),
      checkUrl,
      successStatuses: readList(env, 'VALIDATION_SUCCESS_STATUSES', ['204', '200', '301', '302'])
        .map(Number)
        .filter((code) => Number.isInteger(code) && code > 0),
      requireEgressEcho: readBool(env, 'VALIDATION_REQUIRE_EGRESS_ECHO', false),
      maxPerCycle: readInt(env, 'VALIDATION_MAX_PER_CYCLE', 2_000, 1, 100_000),
    },
    pool: {
      minScore: readInt(env, 'POOL_MIN_SCORE', DEFAULT_SCORING_CONFIG.minPoolScore, 0, 100),
      ttlMinutes: readInt(
        env,
        'POOL_TTL_MINUTES',
        DEFAULT_SCORING_CONFIG.poolTtlMinutes,
        5,
        7 * 24 * 60,
      ),
      maxConsecutiveFailures: readInt(
        env,
        'POOL_MAX_CONSECUTIVE_FAILURES',
        DEFAULT_SCORING_CONFIG.maxConsecutiveFailures,
        1,
        20,
      ),
      maxActive: readInt(env, 'POOL_MAX_ACTIVE', 5_000, 1, 250_000),
      recheckAfterMinutes: readInt(env, 'POOL_RECHECK_AFTER_MINUTES', 15, 1, 24 * 60),
      maxNewPerCycle: readInt(env, 'POOL_MAX_NEW_PER_CYCLE', 1_500, 0, 100_000),
      maxRecheckPerCycle: readInt(env, 'POOL_MAX_RECHECK_PER_CYCLE', 800, 0, 100_000),
      maxQuarantineRecheckPerCycle: readInt(
        env,
        'POOL_MAX_QUARANTINE_RECHECK_PER_CYCLE',
        400,
        0,
        100_000,
      ),
      requireServicePass: readBool(env, 'POOL_REQUIRE_SERVICE_PASS', false),
      idealLatencyMs: readInt(
        env,
        'SCORE_IDEAL_LATENCY_MS',
        DEFAULT_SCORING_CONFIG.idealLatencyMs,
        1,
        30_000,
      ),
      maxLatencyMs: readInt(
        env,
        'SCORE_MAX_LATENCY_MS',
        DEFAULT_SCORING_CONFIG.maxLatencyMs,
        10,
        60_000,
      ),
    },
    serviceCheck: {
      enabled: readBool(env, 'CR_CHECK_ENABLED', true),
      checkPath: readString(env, 'CR_CHECK_PATH', '/robots.txt'),
      scheme: serviceScheme,
      ...(readOptional(env, 'CR_CHECK_URL') ? { checkUrl: readOptional(env, 'CR_CHECK_URL') } : {}),
      rateLimitPerMinute: readInt(env, 'CR_RATE_LIMIT_PER_MINUTE', 30, 1, 600),
      maxChecksPerCycle: readInt(env, 'CR_MAX_CHECKS_PER_CYCLE', 250, 0, 10_000),
      minRequestSpacingMs: readInt(env, 'CR_MIN_REQUEST_SPACING_MS', 250, 0, 60_000),
      timeoutMs: readInt(env, 'CR_TIMEOUT_MS', 8_000, 500, 60_000),
      respectRobots: readBool(env, 'CR_RESPECT_ROBOTS', true),
      userAgent: readString(
        env,
        'CR_USER_AGENT',
        'ProxyPulseBot/1.0 (+https://github.com/harshi79/ProxyPulse-Crunchyroll)',
      ),
      allowRetestBlocked: readBool(env, 'CR_ALLOW_RETEST_BLOCKED', true),
      recheckAfterMinutes: readInt(env, 'CR_RECHECK_AFTER_MINUTES', 6 * 60, 5, 30 * 24 * 60),
      minScore: readInt(env, 'CR_MIN_SCORE', 10, 0, 100),
      allowedHosts: readList(env, 'CR_ALLOWED_HOSTS', [
        'www.crunchyroll.com',
        'crunchyroll.com',
        'static.crunchyroll.com',
      ]),
    },
    security: {
      allowPrivateEndpoints,
      maxRequestBytes: readInt(env, 'MAX_REQUEST_BYTES', 64 * 1024, 512, 16 * 1024 * 1024),
      dnsCacheTtlMs: readInt(env, 'DNS_CACHE_TTL_MS', 60_000, 0, 600_000),
    },
    queue: {
      driver: queueDriver,
      concurrency: readInt(env, 'QUEUE_CONCURRENCY', 4, 1, 32),
      memory: { capacity: readInt(env, 'QUEUE_MEMORY_CAPACITY', 5_000, 10, 200_000) },
      cloudflare: cloudflareQueue,
    },
    retention: {
      resultDays: readInt(env, 'RETENTION_RESULT_DAYS', 7, 1, 365),
      deadProxyDays: readInt(env, 'RETENTION_DEAD_PROXY_DAYS', 14, 1, 365),
      cycleDays: readInt(env, 'RETENTION_CYCLE_DAYS', 30, 1, 365),
    },
    scoring: {
      ...DEFAULT_SCORING_CONFIG,
      idealLatencyMs: readInt(
        env,
        'SCORE_IDEAL_LATENCY_MS',
        DEFAULT_SCORING_CONFIG.idealLatencyMs,
        1,
        30_000,
      ),
      maxLatencyMs: readInt(
        env,
        'SCORE_MAX_LATENCY_MS',
        DEFAULT_SCORING_CONFIG.maxLatencyMs,
        10,
        60_000,
      ),
      poolTtlMinutes: readInt(
        env,
        'POOL_TTL_MINUTES',
        DEFAULT_SCORING_CONFIG.poolTtlMinutes,
        5,
        7 * 24 * 60,
      ),
      maxConsecutiveFailures: readInt(
        env,
        'POOL_MAX_CONSECUTIVE_FAILURES',
        DEFAULT_SCORING_CONFIG.maxConsecutiveFailures,
        1,
        20,
      ),
      minPoolScore: readInt(env, 'POOL_MIN_SCORE', DEFAULT_SCORING_CONFIG.minPoolScore, 0, 100),
    },
  };

  if (config.validation.successStatuses.length === 0) {
    throw new ConfigError('VALIDATION_SUCCESS_STATUSES must contain at least one status code');
  }
  if (config.serviceCheck.enabled && config.serviceCheck.allowedHosts.length === 0) {
    throw new ConfigError('CR_ALLOWED_HOSTS must not be empty while CR_CHECK_ENABLED=true');
  }
  return config;
}

/** Startup warnings that must be visible but are not fatal. */
export function configWarnings(config: WorkerConfig): string[] {
  const warnings: string[] = [];
  if (config.security.allowPrivateEndpoints && config.environment === 'production') {
    warnings.push(
      'ALLOW_PRIVATE_ENDPOINTS=true in production: the worker may connect to internal addresses. Only use this with trusted proxy lists.',
    );
  }
  if (!config.internalApiToken) {
    warnings.push(
      'INTERNAL_API_TOKEN is empty: /internal/* endpoints are disabled (set a token before deploying).',
    );
  }
  if (config.discovery.sources.filter((source) => source.enabled).length === 0) {
    warnings.push(
      'No discovery sources are enabled: cycles will only re-validate proxies already in the database.',
    );
  }
  if (!config.serviceCheck.enabled) {
    warnings.push(
      'Service compatibility checks are disabled: pool scoring uses connectivity metrics only.',
    );
  }
  if (config.pool.requireServicePass && !config.serviceCheck.enabled) {
    warnings.push(
      'POOL_REQUIRE_SERVICE_PASS=true while service checks are disabled: the pool will stay empty.',
    );
  }
  return warnings;
}

export const configLogger = createLogger({ name: 'config' });

/** Logs config safely: secrets never reach stdout, only their presence does. */
export function describeConfig(config: WorkerConfig): Record<string, unknown> {
  return {
    environment: config.environment,
    service: config.service,
    database: redactUrl(config.db.url),
    // named so the log redactor (which hides anything "token"-shaped) leaves these booleans visible
    database_auth_configured: Boolean(config.db.authToken),
    internal_api_auth_configured: Boolean(config.internalApiToken),
    refresh_interval_minutes: config.refresh.intervalMinutes,
    discovery_sources: config.discovery.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      enabled: source.enabled,
      target:
        source.kind === 'local-file'
          ? source.path
          : source.url
            ? redactText(source.url)
            : undefined,
    })),
    validation: {
      concurrency: config.validation.concurrency,
      timeout_ms: config.validation.timeoutMs,
      retries: config.validation.retries,
      check_url: redactText(config.validation.checkUrl),
      require_egress_echo: config.validation.requireEgressEcho,
    },
    pool: config.pool,
    service_check: {
      ...config.serviceCheck,
      check_url: config.serviceCheck.checkUrl
        ? redactText(config.serviceCheck.checkUrl)
        : undefined,
    },
    queue: { driver: config.queue.driver, concurrency: config.queue.concurrency },
    security: { allow_private_endpoints: config.security.allowPrivateEndpoints },
  };
}

export { ConfigError };
