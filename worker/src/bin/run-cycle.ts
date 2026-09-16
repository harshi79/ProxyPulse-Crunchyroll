/**
 * One-shot pipeline run: discovery → validation → service check → scoring → pool.
 *
 *   node worker/dist/bin/run-cycle.js            # run once and exit
 *   node worker/dist/bin/run-cycle.js --serve    # keep the internal API up afterwards
 *
 * Exits non-zero when the cycle fails, which makes it usable as a CI smoke test.
 */

import { parseArgs } from 'node:util';
import {
  configureLogging,
  createLogger,
  errorFields,
  levelFromEnv,
  LOG_EVENTS,
  redactUrl,
} from '@proxypulse/shared';
import { loadConfig } from '../config.js';
import { createRuntime } from '../runtime.js';

const { values } = parseArgs({
  options: {
    serve: { type: 'boolean', default: false },
    port: { type: 'string' },
    'log-level': { type: 'string' },
    quiet: { type: 'boolean', default: false },
  },
});

const config = loadConfig();
const level = levelFromEnv(values['log-level'], config.logLevel);
configureLogging({ level });
const logger = createLogger({ name: 'run-cycle', level });

async function main(): Promise<void> {
  const runtime = await createRuntime({ config, logger, startHttp: values.serve === true });
  if (values.serve === true) {
    const port = values.port === undefined ? config.port : Number(values.port);
    const bound = await runtime.listen(port, config.host);
    logger.info('internal api ready', {
      event: LOG_EVENTS.HTTP_LISTENING,
      port: bound.port,
      host: config.host,
    });
  }

  const started = Date.now();
  const report = await runtime.runCycle({ trigger: values.serve === true ? 'startup' : 'manual' });
  const summary = {
    cycle_id: report.cycle_id,
    status: report.status,
    duration_ms: Date.now() - started,
    discovery: report.discovery,
    validation: report.validation,
    service: report.service,
    pool: report.pool,
    error: report.error,
  };

  if (values.quiet !== true) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
  logger.info('cycle finished', {
    event: report.status === 'completed' ? LOG_EVENTS.CYCLE_COMPLETED : LOG_EVENTS.CYCLE_FAILED,
    cycle_id: report.cycle_id,
    pool_size: report.pool.size,
    database: redactUrl(config.db.url),
  });

  if (values.serve === true) {
    logger.info('serving the internal API; press Ctrl-C to stop', {
      event: LOG_EVENTS.WORKER_STARTED,
    });
    const stop = (): void => {
      void runtime.stop().then(() => process.exit(report.status === 'completed' ? 0 : 1));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  await runtime.stop();
  process.exit(report.status === 'completed' ? 0 : 1);
}

main().catch((error: unknown) => {
  logger.error('one-shot cycle failed', { event: LOG_EVENTS.CYCLE_FAILED, ...errorFields(error) });
  process.exit(1);
});
