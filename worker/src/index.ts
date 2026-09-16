/**
 * Worker entry point (Render web service / any Node host).
 *
 * Boots the runtime, serves the token-protected internal API, starts the 15 minute refresh loop and
 * exits cleanly on SIGTERM. Render gives a short grace period, so an in-flight cycle is allowed to
 * finish (bounded by the scheduler's shutdown grace) instead of leaving the pool half-written.
 */

import {
  configureLogging,
  createLogger,
  errorFields,
  LOG_EVENTS,
  redactUrl,
} from '@proxypulse/shared';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { createRuntime } from './runtime.js';

const version = process.env.npm_package_version ?? '0.1.0';

async function main(): Promise<void> {
  const config = loadConfig();
  configureLogging({ level: config.logLevel });
  const logger = createLogger({
    name: 'worker',
    level: config.logLevel,
    base: { service: config.service },
  });

  const runtime = await createRuntime({ config, logger, version, startHttp: true });
  const { port } = await runtime.listen();
  runtime.scheduler.start();

  let closing = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info('shutdown signal received', { event: LOG_EVENTS.WORKER_STOPPING, signal });
    const force = setTimeout(() => {
      logger.error('shutdown timed out after the grace period', {
        event: LOG_EVENTS.WORKER_STOPPING,
      });
      process.exit(1);
    }, 45_000);
    force.unref();
    try {
      await runtime.stop();
      logger.info('worker stopped', { event: LOG_EVENTS.WORKER_STOPPED });
    } catch (error) {
      logger.error('error while shutting down', {
        event: LOG_EVENTS.WORKER_STOPPING,
        ...errorFields(error),
      });
      exitCode = exitCode || 1;
    } finally {
      clearTimeout(force);
      process.exit(exitCode);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { event: LOG_EVENTS.API_ERROR, ...errorFields(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { event: LOG_EVENTS.API_ERROR, ...errorFields(error) });
    void shutdown('uncaughtException', 1);
  });

  logger.info('worker started', {
    event: LOG_EVENTS.WORKER_STARTED,
    version,
    listen: `${config.host}:${port}`,
    service: config.service,
    environment: config.environment,
    database: redactUrl(config.db.url),
    queue_driver: config.queue.driver,
    ...describeConfig(config),
  });
}

main().catch((error: unknown) => {
  const logger = createLogger({ name: 'worker' });
  logger.error('worker failed to start', {
    event: error instanceof ConfigError ? LOG_EVENTS.CONFIG_ERROR : LOG_EVENTS.WORKER_FAILED,
    ...errorFields(error),
  });
  process.exit(1);
});
