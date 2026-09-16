/**
 * Cloudflare Queues driver (HTTP pull consumer).
 *
 * Why this exists: the pipeline can hand its fan-out work to a durable queue instead of an in-process
 * array, which is what you want when several producers exist or a cycle should survive a restart. The
 * worker is both producer (jobs it just created) and the only consumer (HTTP pull). Everything is
 * optional — with QUEUE_DRIVER=memory the same pipeline runs without Cloudflare at all.
 *
 * Endpoints (Cloudflare REST API):
 *   POST /accounts/{account}/queues/{queue}/messages        producer
 *   POST /accounts/{account}/queues/{queue}/messages/pull   pull consumer
 *   POST /accounts/{account}/queues/{queue}/messages/ack    acknowledge / retry
 */

import { LOG_EVENTS, redactText, type Logger } from '@proxypulse/shared';

import {
  isProxyJob,
  MAX_JOBS_PER_REQUEST,
  type ConsumeOptions,
  type ConsumeSummary,
  type JobHandler,
  type JobQueue,
  type ProxyJob,
} from './types.js';

export interface CloudflareQueueOptions {
  accountId: string;
  queueId: string;
  apiToken: string;
  batchSize: number;
  pollSeconds: number;
  visibilityTimeoutMs: number;
  maxRetries: number;
  logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  apiBase?: string;
}

interface PulledMessage {
  body: unknown;
  lease_id: string;
}

export class CloudflareQueue implements JobQueue {
  readonly driver = 'cloudflare' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private closed = false;
  /** Jobs produced locally in this cycle (the pipeline produces then drains its own work). */
  private readonly outbound: ProxyJob[] = [];
  private dropped = 0;

  constructor(private readonly options: CloudflareQueueOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.base = `${options.apiBase ?? 'https://api.cloudflare.com/client/v4'}/accounts/${encodeURIComponent(
      options.accountId,
    )}/queues/${encodeURIComponent(options.queueId)}`;
  }

  pending(): number {
    return this.outbound.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.outbound.length = 0;
  }

  #headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.apiToken}`,
      'content-type': 'application/json',
    };
  }

  async send(job: ProxyJob): Promise<boolean> {
    if (!isProxyJob(job)) return false;
    this.outbound.push(job);
    return true;
  }

  async sendMany(jobs: readonly ProxyJob[]): Promise<number> {
    let sent = 0;
    for (let start = 0; start < jobs.length; start += MAX_JOBS_PER_REQUEST) {
      const chunk = jobs
        .slice(start, start + MAX_JOBS_PER_REQUEST)
        .filter((job) => isProxyJob(job));
      if (chunk.length === 0) continue;
      const body = JSON.stringify({ messages: chunk.map((job) => ({ body: job })) });
      try {
        const response = await this.fetchImpl(`${this.base}/messages`, {
          method: 'POST',
          headers: this.#headers(),
          body,
        });
        if (!response.ok) {
          const text = redactText(await response.text()).slice(0, 200);
          this.options.logger.warn('queue produce failed', {
            event: LOG_EVENTS.QUEUE_ERROR,
            status: response.status,
            detail: text,
            count: chunk.length,
          });
          continue;
        }
        sent += chunk.length;
      } catch (error) {
        this.options.logger.warn('queue produce error', {
          event: LOG_EVENTS.QUEUE_ERROR,
          error_message:
            error instanceof Error ? redactText(error.message).slice(0, 200) : 'unknown',
        });
      }
    }
    for (const job of this.outbound.splice(0, this.outbound.length)) void job;
    return sent;
  }

  async #pull(signal?: AbortSignal, batchSizeHint?: number): Promise<PulledMessage[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (this.options.pollSeconds + 5) * 1_000);
    signal?.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      const response = await this.fetchImpl(`${this.base}/messages/pull`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({
          batch_size: Math.max(
            1,
            Math.min(this.options.batchSize, batchSizeHint ?? this.options.batchSize),
          ),
          visibility_timeout_ms: this.options.visibilityTimeoutMs,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        // 408 "no messages" is the normal empty-long-poll answer.
        if (response.status !== 408) {
          this.options.logger.warn('queue pull failed', {
            event: LOG_EVENTS.QUEUE_ERROR,
            status: response.status,
            detail: redactText(await response.text()).slice(0, 160),
          });
        }
        return [];
      }
      const payload = (await response.json()) as {
        result?: { messages?: Record<string, unknown>[] };
        messages?: Record<string, unknown>[];
      };
      const messages = payload.result?.messages ?? payload.messages ?? [];
      const out: PulledMessage[] = [];
      for (const message of messages) {
        const metadata = (message.metadata ?? {}) as Record<string, unknown>;
        const leaseId = metadata.lease_id ?? message.lease_id;
        if (typeof leaseId !== 'string') continue;
        out.push({ body: message.body ?? message, lease_id: leaseId });
      }
      return out;
    } catch (error) {
      if (!controller.signal.aborted) {
        this.options.logger.warn('queue pull error', {
          event: LOG_EVENTS.QUEUE_ERROR,
          error_message:
            error instanceof Error ? redactText(error.message).slice(0, 160) : 'unknown',
        });
      }
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async #ack(leaseIds: readonly string[], retries: readonly string[] = []): Promise<void> {
    if (leaseIds.length === 0 && retries.length === 0) return;
    try {
      await this.fetchImpl(`${this.base}/messages/ack`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({
          acks: leaseIds.map((lease_id) => ({ lease_id })),
          retries: retries.map((lease_id) => ({ lease_id })),
        }),
      });
    } catch (error) {
      this.options.logger.warn('queue ack failed', {
        event: LOG_EVENTS.QUEUE_ERROR,
        error_message: error instanceof Error ? redactText(error.message).slice(0, 160) : 'unknown',
      });
    }
  }

  /** Long-polls the queue and executes jobs with bounded concurrency. Runs until closed/aborted. */
  async consume(handler: JobHandler, options: ConsumeOptions): Promise<ConsumeSummary> {
    const summary: ConsumeSummary = {
      processed: 0,
      failed: 0,
      dropped: 0,
      enqueued: this.outbound.length,
    };
    if (this.outbound.length > 0) {
      const produced = this.outbound.splice(0, this.outbound.length);
      await this.sendMany(produced);
    }

    let handled = 0;
    const budget = options.maxJobs ?? Number.POSITIVE_INFINITY;
    for (;;) {
      if (this.closed || options.signal?.aborted || handled >= budget) break;
      const messages = await this.#pull(options.signal, budget - handled);
      if (messages.length === 0) {
        // the pull API is short-polling: an empty answer ends a drain, and a service loop must back
        // off instead of spinning against the REST API
        if (options.drainOnly) break;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(60_000, this.options.pollSeconds * 1_000)),
        );
        continue;
      }
      handled += messages.length;
      const acks: string[] = [];
      const retryLeases: string[] = [];

      for (let start = 0; start < messages.length; start += options.concurrency) {
        const batch = messages.slice(start, start + options.concurrency);
        const outcomes = await Promise.all(
          batch.map(async (message) => {
            if (!isProxyJob(message.body)) {
              return { lease_id: message.lease_id, ok: true, invalid: true };
            }
            try {
              await handler(message.body);
              return { lease_id: message.lease_id, ok: true, invalid: false };
            } catch (error) {
              const attempt = (message.body.attempt ?? 1) + 1;
              const exhausted = attempt > this.options.maxRetries;
              if (!exhausted) retryLeases.push(message.lease_id);
              this.options.logger.warn('queue job failed', {
                event: LOG_EVENTS.QUEUE_JOB_FAILED,
                job_id: message.body.job_id,
                type: message.body.type,
                attempt,
                exhausted,
                error_message:
                  error instanceof Error ? redactText(error.message).slice(0, 200) : 'unknown',
              });
              return { lease_id: message.lease_id, ok: false, invalid: false };
            }
          }),
        );
        for (const outcome of outcomes) {
          if (outcome.invalid) summary.dropped += 1;
          if (outcome.ok) summary.processed += 1;
          else summary.failed += 1;
          if (!retryLeases.includes(outcome.lease_id)) acks.push(outcome.lease_id);
        }
      }

      await this.#ack(acks, retryLeases);
      // a short batch means the queue is empty right now: stop instead of long-polling for more
      if (options.drainOnly && messages.length < this.options.batchSize) break;
    }
    summary.dropped += this.dropped;
    return summary;
  }
}
