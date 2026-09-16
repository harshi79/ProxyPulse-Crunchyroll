/**
 * Queue factory. `memory` is the default so the worker runs anywhere; `cloudflare` uses the
 * Cloudflare Queues HTTP pull API (see DEPLOYMENT.md for the wrangler + token setup).
 */

import type { Logger } from '@proxypulse/shared';

import type { WorkerConfig } from '../config.js';
import { CloudflareQueue } from './cloudflare-queue.js';
import { MemoryQueue } from './memory-queue.js';
import type { JobQueue } from './types.js';

export * from './types.js';

export interface CreateQueueOptions {
  config: WorkerConfig;
  logger: Logger;
  fetch?: typeof fetch;
}

export function createJobQueue(options: CreateQueueOptions): JobQueue {
  const { config, logger } = options;
  if (config.queue.driver === 'cloudflare' && config.queue.cloudflare) {
    const cf = config.queue.cloudflare;
    return new CloudflareQueue({
      accountId: cf.accountId,
      queueId: cf.queueId,
      apiToken: cf.apiToken,
      batchSize: cf.batchSize,
      pollSeconds: cf.pollSeconds,
      visibilityTimeoutMs: cf.visibilityTimeoutMs,
      maxRetries: cf.maxRetries,
      logger,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  return new MemoryQueue({ capacity: config.queue.memory.capacity, logger });
}
