/**
 * Job model + queue contract.
 *
 * Payloads carry identifiers only (proxy ids, cycle id) — never proxy credentials, never tokens,
 * never a blob of proxy data. That keeps the queue small and safe to inspect in the dashboard.
 */

export const JOB_TYPES = [
  'DISCOVER',
  'VALIDATE',
  'SERVICE_CHECK',
  'RECHECK',
  'POOL_UPDATE',
  'STATS_UPDATE',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export type RecheckReason = 'new' | 'recheck' | 'revive' | 'manual' | 'stale_service';

export interface ProxyJob {
  job_id: string;
  type: JobType;
  cycle_id: string;
  issued_at: string;
  proxy_id?: number;
  reason?: RecheckReason;
  /** Bumped by the consumer on each delivery attempt; used for bounded retries. */
  attempt?: number;
}

export type JobHandler = (job: ProxyJob) => Promise<void>;

export interface ConsumeOptions {
  concurrency: number;
  signal?: AbortSignal;
  /** Stop after the queue drains (in-process driver) instead of waiting for work. */
  drainOnly?: boolean;
  maxJobs?: number;
}

export interface ConsumeSummary {
  processed: number;
  failed: number;
  dropped: number;
  enqueued: number;
}

export interface JobQueue {
  readonly driver: 'memory' | 'cloudflare';
  send(job: ProxyJob): Promise<boolean>;
  sendMany(jobs: readonly ProxyJob[]): Promise<number>;
  consume(handler: JobHandler, options: ConsumeOptions): Promise<ConsumeSummary>;
  pending(): number;
  close(): Promise<void>;
}

/** Small, validated payload shape check used by producers and consumers. */
export function isProxyJob(value: unknown): value is ProxyJob {
  if (value === null || typeof value !== 'object') return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.job_id === 'string' &&
    typeof job.cycle_id === 'string' &&
    typeof job.type === 'string' &&
    (JOB_TYPES as readonly string[]).includes(job.type) &&
    (job.proxy_id === undefined || typeof job.proxy_id === 'number')
  );
}

export const MAX_JOBS_PER_REQUEST = 100;
