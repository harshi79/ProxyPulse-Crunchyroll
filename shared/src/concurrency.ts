/**
 * Small bounded-execution primitives: bounded concurrency, timeout, retry with backoff and a token
 * bucket rate limiter. These are what keep the pipeline from becoming a request flood.
 */

export class TimeoutError extends Error {
  constructor(ms: number, label = 'operation') {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export class AbortedError extends Error {
  constructor(label = 'operation') {
    super(`${label} aborted`);
    this.name = 'AbortedError';
  }
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError('sleep'));
      return;
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortedError('sleep'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Rejects with TimeoutError when `promise` does not settle within `ms`. Always cleans up. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'operation',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(ms, label)), Math.max(1, ms));
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface RetryOptions {
  /** Total attempts, including the first one. `1` disables retrying. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  /** Random jitter fraction applied to each delay (0..1). */
  jitter?: number;
  signal?: AbortSignal;
  retryable?: (error: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export interface RetryResult<T> {
  value: T;
  attempts: number;
  errors: unknown[];
}

/**
 * Exponential backoff retry with jitter and a hard attempt cap.
 * Throws the last error if all attempts fail (or the error is not retryable).
 */
export async function attemptWithRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryResult<T>> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const base = options.baseDelayMs ?? 250;
  const max = options.maxDelayMs ?? 4_000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? 0.2;
  const errors: unknown[] = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) throw new AbortedError('retry');
    try {
      const value = await task(attempt);
      return { value, attempts: attempt, errors };
    } catch (error) {
      errors.push(error);
      const last = attempt >= attempts;
      if (last || (options.retryable && !options.retryable(error))) throw error;
      const raw = Math.min(max, base * factor ** (attempt - 1));
      const delayMs = Math.round(raw * (1 - jitter / 2 + Math.random() * jitter));
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, options.signal);
    }
  }
  // Unreachable: the loop always returns or throws.
  throw errors[errors.length - 1];
}

/**
 * Maps over items with at most `limit` tasks in flight. Never rejects because of a task error:
 * errors are captured per item so one bad proxy cannot abort a whole batch.
 */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<Settled<R>[]> {
  const total = items.length;
  const results = new Array<Settled<R>>(total);
  if (total === 0) return results;
  const concurrency = Math.max(1, Math.min(Math.floor(limit) || 1, total));
  let cursor = 0;
  let done = 0;

  const run = async (index: number): Promise<void> => {
    if (options.signal?.aborted) {
      results[index] = { ok: false, error: new AbortedError('mapWithConcurrency') };
      return;
    }
    const item = items[index] as T;
    try {
      results[index] = { ok: true, value: await worker(item, index) };
    } catch (error) {
      results[index] = { ok: false, error };
    } finally {
      done += 1;
      options.onProgress?.(done, total);
    }
  };

  const runner = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= total) return;
      await run(index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runner()));
  return results;
}

/**
 * Simple token bucket used to bound requests-per-second towards a target service.
 * `capacity` is the burst allowance, `refillPerSecond` the sustained rate.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  private refill(): void {
    const current = this.now();
    const elapsedMs = Math.max(0, current - this.lastRefill);
    if (elapsedMs === 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.refillPerSecond);
    this.lastRefill = current;
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }

  tryTake(count = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /** Resolves as soon as `count` tokens are available (or immediately when aborted). */
  async take(count = 1, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new AbortedError('token bucket');
      this.refill();
      if (this.tokens >= count) {
        this.tokens -= count;
        return;
      }
      const missing = count - this.tokens;
      const waitMs = Math.max(
        5,
        Math.ceil((missing / Math.max(0.001, this.refillPerSecond)) * 1000),
      );
      await sleep(Math.min(waitMs, 2_000), signal);
    }
  }
}

/** Guards against overlapping executions of the same long-running task (e.g. two cycles at once). */
export function createMutex<T>(
  fn: () => Promise<T>,
): (() => Promise<T | null>) & { locked: () => boolean } {
  let running: Promise<T> | null = null;
  const wrapped = async (): Promise<T | null> => {
    if (running) return null;
    running = fn().finally(() => {
      running = null;
    });
    return await running;
  };
  return Object.assign(wrapped, { locked: () => running !== null });
}
