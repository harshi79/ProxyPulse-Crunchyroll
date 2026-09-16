/**
 * The job queue contract. Both drivers must agree on the semantics the pipeline relies on: payloads
 * carry identifiers only, work is bounded, failures are retried a bounded number of times, and nothing
 * is ever lost silently without being counted.
 */

import { describe, expect, it } from 'vitest';
import { createLogger } from '@proxypulse/shared';
import { CloudflareQueue } from '../worker/src/queue/cloudflare-queue';
import { MemoryQueue } from '../worker/src/queue/memory-queue';
import {
  isProxyJob,
  MAX_JOBS_PER_REQUEST,
  type JOB_TYPES,
  type ProxyJob,
} from '../worker/src/queue/types';
import { createJobQueue } from '../worker/src/queue/index';
import { loadConfig } from '../worker/src/config';

const logger = createLogger({ name: 'queue-test', level: 'error' });

const job = (overrides: Partial<ProxyJob> = {}): ProxyJob => ({
  job_id: 'job_1',
  type: 'VALIDATE',
  cycle_id: 'cyc_1',
  issued_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  proxy_id: 42,
  ...overrides,
});

describe('job payloads', () => {
  it('accept only known types and identifier-only bodies', () => {
    expect(isProxyJob(job())).toBe(true);
    expect(isProxyJob(job({ type: 'RECHECK' as (typeof JOB_TYPES)[number] }))).toBe(true);
    expect(isProxyJob({ ...job(), type: 'DROP_TABLE' })).toBe(false);
    expect(isProxyJob({ ...job(), proxy_id: '42' })).toBe(false);
    expect(isProxyJob({ ...job(), job_id: undefined })).toBe(false);
    expect(isProxyJob(null)).toBe(false);
    expect(isProxyJob('job_1')).toBe(false);
  });

  it('never carries proxy credentials or tokens, in any driver', async () => {
    const payload = job({ type: 'SERVICE_CHECK' });
    expect(Object.keys(payload).sort()).toEqual([
      'cycle_id',
      'issued_at',
      'job_id',
      'proxy_id',
      'type',
    ]);
    const queue = new MemoryQueue({ capacity: 10, logger });
    await queue.send(payload);
    const seen: ProxyJob[] = [];
    await queue.consume(async (queued) => void seen.push(queued), {
      concurrency: 1,
      drainOnly: true,
    });
    const serialised = JSON.stringify(seen);
    for (const forbidden of ['password', 'username', 'token', 'authorization', 'host']) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });
});

describe('memory queue', () => {
  it('processes in FIFO order and reports what it did', async () => {
    const queue = new MemoryQueue({ capacity: 100, logger });
    await queue.sendMany([job({ job_id: 'a' }), job({ job_id: 'b' }), job({ job_id: 'c' })]);
    expect(queue.pending()).toBe(3);
    const order: string[] = [];
    const summary = await queue.consume(async (queued) => void order.push(queued.job_id), {
      concurrency: 2,
      drainOnly: true,
    });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(summary).toMatchObject({ processed: 3, failed: 0, dropped: 0 });
    expect(queue.pending()).toBe(0);
  });

  it('drops (does not accept) work beyond its capacity', async () => {
    const queue = new MemoryQueue({ capacity: 2, logger });
    expect(await queue.send(job({ job_id: 'a' }))).toBe(true);
    expect(await queue.send(job({ job_id: 'b' }))).toBe(true);
    expect(await queue.send(job({ job_id: 'c' }))).toBe(false);
    expect(queue.pending()).toBe(2);
    const summary = await queue.consume(async () => undefined, { concurrency: 1, drainOnly: true });
    expect(summary.dropped).toBe(1);
  });

  it('rejects malformed payloads instead of handing them to a handler', async () => {
    const queue = new MemoryQueue({ capacity: 5, logger });
    expect(
      await queue.send({
        job_id: 'x',
        type: 'NOPE',
        cycle_id: 'c',
        issued_at: 'now',
      } as unknown as ProxyJob),
    ).toBe(false);
    let handled = 0;
    await queue.consume(async () => void (handled += 1), { concurrency: 1, drainOnly: true });
    expect(handled).toBe(0);
  });

  it('retries a failing job up to maxAttempts and then drops it', async () => {
    const queue = new MemoryQueue({ capacity: 10, maxAttempts: 3, logger });
    await queue.send(job());
    const attempts: number[] = [];
    const summary = await queue.consume(
      async (queued) => {
        attempts.push(queued.attempt ?? 0);
        throw new Error('proxy vanished');
      },
      { concurrency: 1, drainOnly: true, maxJobs: 10 },
    );
    expect(attempts).toEqual([1, 2, 3]);
    expect(summary.failed).toBe(3);
    expect(summary.processed).toBe(0);
    expect(queue.pending()).toBe(0);
  });

  it('respects maxJobs so a cycle can only consume its own work', async () => {
    const queue = new MemoryQueue({ capacity: 100, logger });
    await queue.sendMany(Array.from({ length: 10 }, (_, index) => job({ job_id: `j${index}` })));
    let handled = 0;
    await queue.consume(async () => void (handled += 1), {
      concurrency: 2,
      drainOnly: true,
      maxJobs: 4,
    });
    expect(handled).toBe(4);
    expect(queue.pending()).toBe(6);
  });

  it('stops early when the consumer is aborted', async () => {
    const queue = new MemoryQueue({ capacity: 100, logger });
    await queue.sendMany(Array.from({ length: 20 }, (_, index) => job({ job_id: `j${index}` })));
    const controller = new AbortController();
    let handled = 0;
    await queue.consume(
      async () => {
        handled += 1;
        if (handled === 2) controller.abort();
      },
      { concurrency: 1, drainOnly: true, signal: controller.signal },
    );
    expect(handled).toBeLessThanOrEqual(3);
    expect(queue.pending()).toBeGreaterThan(0);
  });

  it('clears the backlog on close', async () => {
    const queue = new MemoryQueue({ capacity: 10, logger });
    await queue.send(job());
    await queue.close();
    expect(queue.pending()).toBe(0);
  });
});

interface FakeCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Minimal stand-in for the Cloudflare Queues REST API (produce / pull / ack). */
const fakeCloudflare = (options: { batches?: ProxyJob[][]; producerStatus?: number } = {}) => {
  const calls: FakeCall[] = [];
  const pending = [...(options.batches ?? [])];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({
      url: input,
      method: init?.method ?? 'GET',
      body,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });
    if (input.endsWith('/messages')) {
      const messages = (body as { messages: { body: ProxyJob }[] }).messages;
      (pending[0] ??= []).push(...messages.map((message) => message.body));
      return new Response('', { status: options.producerStatus ?? 200 });
    }
    if (input.endsWith('/messages/pull')) {
      const batch = pending.shift();
      if (!batch || batch.length === 0) return new Response('', { status: 408 });
      const requested = (body as { batch_size?: number }).batch_size ?? 10;
      const slice = batch.slice(0, requested);
      const rest = batch.slice(slice.length);
      if (rest.length > 0) pending.unshift(rest);
      return Response.json({
        success: true,
        result: {
          messages: slice.map((messageBody, index) => ({
            body: messageBody,
            metadata: { lease_id: `lease_${index + 1}` },
          })),
        },
      });
    }
    if (input.endsWith('/messages/ack')) return new Response('', { status: 200 });
    return new Response('nope', { status: 500 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const cfOptions = (
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof CloudflareQueue>[0]> = {},
) => ({
  accountId: 'acct',
  queueId: 'proxypulse-jobs',
  apiToken: 'cf_token_that_must_not_appear_in_logs',
  batchSize: 16,
  pollSeconds: 1,
  visibilityTimeoutMs: 30_000,
  maxRetries: 2,
  logger,
  fetch: fetchImpl,
  apiBase: 'https://api.example.test/client/v4',
  ...overrides,
});

describe('cloudflare queues driver', () => {
  it('produces jobs in bounded chunks with the pull-consumer shape', async () => {
    const { calls, fetchImpl } = fakeCloudflare({ batches: [[]] });
    const queue = new CloudflareQueue(cfOptions(fetchImpl));
    const count = await queue.sendMany(
      Array.from({ length: MAX_JOBS_PER_REQUEST * 2 + 5 }, (_, index) =>
        job({ job_id: `j${index}` }),
      ),
    );
    expect(count).toBe(MAX_JOBS_PER_REQUEST * 2 + 5);
    const produce = calls.filter((call) => call.url.endsWith('/messages'));
    expect(produce).toHaveLength(3);
    expect((produce[0]?.body as { messages: unknown[] }).messages).toHaveLength(
      MAX_JOBS_PER_REQUEST,
    );
    expect(queue.pending()).toBe(0);
    expect(produce[0]?.method).toBe('POST');
    expect(JSON.stringify(calls)).toContain('Bearer cf_token_that_must_not_appear_in_logs');
  });

  it('reports a producer failure without throwing', async () => {
    const { fetchImpl } = fakeCloudflare({ producerStatus: 403 });
    const queue = new CloudflareQueue(cfOptions(fetchImpl));
    expect(await queue.sendMany([job(), job({ job_id: 'b' })])).toBe(0);
  });

  it('pulls, executes and acknowledges', async () => {
    const { calls, fetchImpl } = fakeCloudflare({
      batches: [[job({ job_id: 'a' }), job({ job_id: 'b' })], []],
    });
    const queue = new CloudflareQueue(cfOptions(fetchImpl));
    const done: string[] = [];
    const summary = await queue.consume(async (queued) => void done.push(queued.job_id), {
      concurrency: 2,
      drainOnly: true,
      maxJobs: 50,
    });
    expect(done).toEqual(['a', 'b']);
    expect(summary.processed).toBe(2);
    const ack = calls.find((call) => call.url.endsWith('/messages/ack'));
    expect(
      (ack?.body as { acks: { lease_id: string }[] }).acks.map((entry) => entry.lease_id),
    ).toEqual(['lease_1', 'lease_2']);
    expect((ack?.body as { retries: unknown[] }).retries).toHaveLength(0);
  });

  it('asks for a retry instead of an ack when a job fails', async () => {
    const { calls, fetchImpl } = fakeCloudflare({ batches: [[job({ job_id: 'a' })], []] });
    const queue = new CloudflareQueue(cfOptions(fetchImpl));
    const summary = await queue.consume(
      async () => {
        throw new Error('validation exploded');
      },
      { concurrency: 1, drainOnly: true, maxJobs: 10 },
    );
    expect(summary.failed).toBe(1);
    const ack = calls.find((call) => call.url.endsWith('/messages/ack'));
    expect((ack?.body as { acks: unknown[] }).acks).toHaveLength(0);
    expect(
      (ack?.body as { retries: { lease_id: string }[] }).retries.map((entry) => entry.lease_id),
    ).toEqual(['lease_1']);
  });

  it('ack-drops a message whose payload is not a job', async () => {
    const fetchImpl = (async (input: string) => {
      if (input.endsWith('/messages/pull')) {
        return Response.json({
          result: {
            messages: [{ body: { type: 'EVAL', evil: true }, metadata: { lease_id: 'lease_1' } }],
          },
        });
      }
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const queue = new CloudflareQueue(cfOptions(fetchImpl));
    let handled = 0;
    const summary = await queue.consume(async () => void (handled += 1), {
      concurrency: 1,
      drainOnly: true,
      maxJobs: 5,
    });
    expect(handled).toBe(0);
    expect(summary.dropped).toBe(1);
  });

  it('drains at most maxJobs and clamps the pull batch size', async () => {
    const many = Array.from({ length: 40 }, (_, index) => job({ job_id: `j${index}` }));
    const { calls, fetchImpl } = fakeCloudflare({
      batches: [many.slice(0, 16), many.slice(16, 32), []],
    });
    const queue = new CloudflareQueue(cfOptions(fetchImpl));
    let handled = 0;
    await queue.consume(async () => void (handled += 1), {
      concurrency: 4,
      drainOnly: true,
      maxJobs: 20,
    });
    expect(handled).toBe(20);
    const pulls = calls.filter((call) => call.url.endsWith('/messages/pull'));
    expect((pulls[0]?.body as { batch_size: number }).batch_size).toBe(16);
    expect((pulls[1]?.body as { batch_size: number }).batch_size).toBe(4);
  });

  it('stops pulling once closed', async () => {
    const { fetchImpl } = fakeCloudflare({ batches: [[]] });
    const queue = new CloudflareQueue(cfOptions(fetchImpl));
    await queue.close();
    const summary = await queue.consume(async () => undefined, {
      concurrency: 1,
      drainOnly: true,
      maxJobs: 5,
    });
    expect(summary.processed).toBe(0);
  });
});

describe('queue factory', () => {
  const base = { ENVIRONMENT: 'test', DATABASE_URL: 'file:x.db' };

  it('defaults to the memory driver', () => {
    const config = loadConfig({ env: base });
    const queue = createJobQueue({ config, logger });
    expect(queue.driver).toBe('memory');
  });

  it('uses cloudflare only when the credentials are present', () => {
    const withCf = loadConfig({
      env: {
        ...base,
        QUEUE_DRIVER: 'cloudflare',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_QUEUE_ID: 'proxypulse-jobs',
        CLOUDFLARE_QUEUES_TOKEN: 'tok',
      },
    });
    expect(createJobQueue({ config: withCf, logger }).driver).toBe('cloudflare');
    // refusing to start is better than silently running a queue the operator thinks is durable
    expect(() => loadConfig({ env: { ...base, QUEUE_DRIVER: 'cloudflare' } })).toThrow(
      /requires CLOUDFLARE_ACCOUNT_ID/,
    );
  });
});
