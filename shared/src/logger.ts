/**
 * Structured logging. Every line is a single JSON object so Render/Cloudflare log viewers can
 * filter by event, cycle id, job id or request id. All payloads pass through redaction.
 */

import { redactValue } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Well known event names. Use these instead of free-form prose so logs stay greppable. */
export const LOG_EVENTS = {
  WORKER_STARTED: 'WORKER_STARTED',
  WORKER_STOPPING: 'WORKER_STOPPING',
  WORKER_STOPPED: 'WORKER_STOPPED',
  WORKER_FAILED: 'WORKER_FAILED',
  CONFIG_ERROR: 'CONFIG_ERROR',
  CONFIG_WARNING: 'CONFIG_WARNING',
  DB_MIGRATION_APPLIED: 'DB_MIGRATION_APPLIED',
  DB_ERROR: 'DB_ERROR',
  CYCLE_STARTED: 'CYCLE_STARTED',
  CYCLE_COMPLETED: 'CYCLE_COMPLETED',
  CYCLE_FAILED: 'CYCLE_FAILED',
  CYCLE_SKIPPED: 'CYCLE_SKIPPED',
  DISCOVERY_STARTED: 'DISCOVERY_STARTED',
  DISCOVERY_SOURCE_COMPLETED: 'DISCOVERY_SOURCE_COMPLETED',
  DISCOVERY_SOURCE_FAILED: 'DISCOVERY_SOURCE_FAILED',
  DISCOVERY_SOURCE_ROBOTS: 'DISCOVERY_SOURCE_ROBOTS',
  DISCOVERY_COMPLETED: 'DISCOVERY_COMPLETED',
  VALIDATION_STARTED: 'VALIDATION_STARTED',
  VALIDATION_COMPLETED: 'VALIDATION_COMPLETED',
  VALIDATION_REJECTED_ENDPOINT: 'VALIDATION_REJECTED_ENDPOINT',
  SERVICE_CHECK_STARTED: 'SERVICE_CHECK_STARTED',
  SERVICE_CHECK_COMPLETED: 'SERVICE_CHECK_COMPLETED',
  SERVICE_CHECK_SKIPPED: 'SERVICE_CHECK_SKIPPED',
  SCORING_COMPLETED: 'SCORING_COMPLETED',
  POOL_UPDATED: 'POOL_UPDATED',
  POOL_QUARANTINED: 'POOL_QUARANTINED',
  POOL_EXPIRED: 'POOL_EXPIRED',
  STATS_UPDATED: 'STATS_UPDATED',
  QUEUE_JOB_ENQUEUED: 'QUEUE_JOB_ENQUEUED',
  QUEUE_JOB_COMPLETED: 'QUEUE_JOB_COMPLETED',
  QUEUE_JOB_FAILED: 'QUEUE_JOB_FAILED',
  QUEUE_ERROR: 'QUEUE_ERROR',
  HTTP_LISTENING: 'HTTP_LISTENING',
  API_REQUEST: 'API_REQUEST',
  API_ERROR: 'API_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  SSRF_BLOCKED: 'SSRF_BLOCKED',
} as const;

export type LogEventName = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS] | (string & {});

export interface LogFields {
  event?: LogEventName;
  [key: string]: unknown;
}

export type LogSink = (line: string, level: LogLevel) => void;

/** Default sink: stdout/stderr JSON lines, which is what Render expects. */
const consoleSink: LogSink = (line, level) => {
  if (level === 'error' || level === 'warn') console.error(line);
  // eslint-disable-next-line no-console -- see above
  else console.log(line);
};

export interface LoggerOptions {
  level?: LogLevel;
  name?: string;
  /** Fields attached to every line from this logger (e.g. { component: 'discovery' }). */
  base?: LogFields;
  sink?: LogSink;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

export interface Logger {
  readonly name: string;
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(name: string, fields?: LogFields): Logger;
  isDebugEnabled(): boolean;
}

interface GlobalLoggerConfig {
  level: LogLevel;
  sink: LogSink;
  now: () => number;
}

const globalConfig: GlobalLoggerConfig = {
  level: 'info',
  sink: consoleSink,
  now: () => Date.now(),
};

export function configureLogging(options: Partial<GlobalLoggerConfig>): void {
  if (options.level) globalConfig.level = options.level;
  if (options.sink) globalConfig.sink = options.sink;
  if (options.now) globalConfig.now = options.now;
}

export function levelFromEnv(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  const candidate = (value ?? '').trim().toLowerCase();
  return candidate === 'debug' ||
    candidate === 'info' ||
    candidate === 'warn' ||
    candidate === 'error'
    ? candidate
    : fallback;
}

function serialize(fields: LogFields | undefined): LogFields {
  if (!fields) return {};
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = redactValue(value, key);
  }
  return out;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? globalConfig.level;
  const sink = options.sink ?? globalConfig.sink;
  const now = options.now ?? globalConfig.now;
  const threshold = LEVEL_ORDER[level];

  const emit = (severity: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[severity] < threshold) return;
    const line: Record<string, unknown> = {
      ts: new Date(now()).toISOString(),
      level: severity,
      logger: options.name ?? 'app',
      msg: message,
      ...(options.base ? serialize(options.base) : {}),
      ...(fields ? serialize(fields) : {}),
    };
    let payload: string;
    try {
      payload = JSON.stringify(line);
    } catch {
      payload = JSON.stringify({ ts: line.ts, level: severity, logger: line.logger, msg: message });
    }
    sink(payload, severity);
  };

  const logger: Logger = {
    name: options.name ?? 'app',
    level,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    isDebugEnabled: () => LEVEL_ORDER.debug >= threshold,
    child: (name, fields) =>
      createLogger({
        name: `${options.name ? `${options.name}:` : ''}${name}`,
        level: options.level,
        sink: options.sink,
        now: options.now,
        base: { ...(options.base ?? {}), ...(fields ?? {}) },
      }),
  };
  return logger;
}

/** Normalizes thrown values into loggable fields (never leaking the raw stack into the API). */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      error: error.name,
      error_message: redactValue(error.message, 'error_message'),
      ...((error as Error & { code?: string }).code
        ? { error_code: (error as Error & { code?: string }).code }
        : {}),
    };
  }
  return { error: redactValue(error, 'error') };
}

export { consoleSink };
