/**
 * In-process bounded queue. Default driver: keeps the pipeline asynchronous (with per-job retries and
 * a bounded backlog) without requiring Cloudflare credentials. When a job cannot be handled the cycle
 * fails gracefully rather than crashing the worker.
 */

import type { Logger } from '@proxypulse/shared';

import {
  isProxyJob,
  type ConsumeOptions,
  type ConsumeSummary,
  type JobHandler,
  type JobQueue,
  type ProxyJob,
} from './types.js';

export interface MemoryQueueOptions {
  capacity: number;
  maxAttempts?: number;
  logger: Logger;
}

export class MemoryQueue implements JobQueue {
  readonly driver = 'memory' as const;
  private readonly queue: ProxyJob[] = [];
  private readonly maxAttempts: number;
  private dropped = 0;
  private notify: (() => void) | null = null;

  constructor(private readonly options: MemoryQueueOptions) {
    this.maxAttempts = options.maxAttempts ?? 2;
  }

  pending(): number {
    return this.queue.length;
  }

  async send(job: ProxyJob): Promise<boolean> {
    if (!isProxyJob(job)) {
      this.options.logger.warn('rejected malformed job payload');
      return false;
    }
    if (this.queue.length >= this.options.capacity) {
      this.dropped += 1;
      return false;
    }
    this.queue.push({ ...job, attempt: job.attempt ?? 1 });
    this.notify?.();
    return true;
  }

  async sendMany(jobs: readonly ProxyJob[]): Promise<number> {
    let sent = 0;
    for (const job of jobs) if (await this.send(job)) sent += 1;
    return sent;
  }

  /** Processes jobs with bounded concurrency; requeues retryable failures up to maxAttempts. */
  async consume(handler: JobHandler, options: ConsumeOptions): Promise<ConsumeSummary> {
    const summary: ConsumeSummary = {
      processed: 0,
      failed: 0,
      dropped: this.dropped,
      enqueued: this.queue.length,
    };
    const limit = Math.max(1, options.concurrency);
    let budget = options.maxJobs ?? Number.POSITIVE_INFINITY;

    while (this.queue.length > 0 && budget > 0) {
      const retryable: ProxyJob[] = [];
      const batch = this.queue.splice(0, Math.min(limit, budget));
      budget -= batch.length;
      const results = await Promise.all(
        batch.map(async (job) => {
          try {
            await handler(job);
            return { ok: true as const, job };
          } catch (error) {
            return { ok: false as const, job, error };
          }
        }),
      );
      for (const result of results) {
        if (result.ok) {
          summary.processed += 1;
          continue;
        }
        summary.failed += 1;
        const attempt = result.job.attempt ?? 1;
        if (attempt < this.maxAttempts) {
          retryable.push({ ...result.job, attempt: attempt + 1 });
        } else {
          this.dropped += 1;
          this.options.logger.warn('job dropped after retries', {
            job_id: result.job.job_id,
            type: result.job.type,
            attempts: attempt,
            error_message:
              result.error instanceof Error ? result.error.message.slice(0, 200) : 'unknown',
          });
        }
      }
      // requeue at the tail (inside the drain, so a transient failure still gets its retry) so one hot
      // failing job cannot starve the rest
      for (const requeued of retryable) {
        if (this.queue.length < this.options.capacity) this.queue.push(requeued);
        else this.dropped += 1;
      }
      if (options.signal?.aborted) break;
    }

    summary.dropped = this.dropped;
    return summary;
  }

  async close(): Promise<void> {
    this.queue.length = 0;
  }
}
