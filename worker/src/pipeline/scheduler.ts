/**
 * The 15 minute scheduler. Single-flight (a cycle never overlaps itself), jittered so replicas do not
 * stampede, and it survives a failing cycle by simply trying again on the next tick.
 */

import { errorFields, LOG_EVENTS, type Logger } from '@proxypulse/shared';
import { META_KEYS, type MetaRepository } from '@proxypulse/db';

import type { CycleReport } from './cycle.js';

export interface SchedulerStatus {
  running: boolean;
  current_cycle_id: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_result: 'completed' | 'failed' | null;
  last_duration_ms: number | null;
  cycles_completed: number;
  cycles_failed: number;
  started_at: string;
  uptime_ms: number;
  interval_minutes: number;
  stopping: boolean;
}

export interface SchedulerDeps {
  intervalMinutes: number;
  runOnStartup: boolean;
  jitterSeconds: number;
  shutdownGraceMs: number;
  logger: Logger;
  meta: MetaRepository;
  runCycle: (options: { trigger: 'scheduler' | 'startup' | 'manual' }) => Promise<CycleReport>;
  now?: () => number;
}

const STARTUP_DELAY_MS = 1_500;
const MIN_DELAY_MS = 5_000;

export class RefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last: CycleReport | null = null;
  private lastRunAt: string | null = null;
  private lastResult: 'completed' | 'failed' | null = null;
  private completed = 0;
  private failed = 0;
  private busy = false;
  private stopping = false;
  private nextRunAt: string | null = null;
  private readonly startedAtMs: number;
  private readonly startedAtIso: string;

  constructor(private readonly deps: SchedulerDeps) {
    this.startedAtMs = deps.now?.() ?? Date.now();
    this.startedAtIso = new Date(this.startedAtMs).toISOString();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private intervalMs(): number {
    return this.deps.intervalMinutes * 60_000;
  }

  private jitterMs(): number {
    const spread = this.deps.jitterSeconds * 1_000;
    if (spread <= 0) return 0;
    return Math.round((Math.random() * 2 - 1) * spread);
  }

  private async persistNextRun(): Promise<void> {
    if (!this.nextRunAt) return;
    try {
      await this.deps.meta.set(META_KEYS.nextRunAt, this.nextRunAt);
    } catch {
      /* the loop must not die because a metadata write failed */
    }
  }

  start(): void {
    this.deps.logger.info('scheduler started', {
      event: LOG_EVENTS.WORKER_STARTED,
      interval_minutes: this.deps.intervalMinutes,
      run_on_startup: this.deps.runOnStartup,
    });
    const delay = this.deps.runOnStartup
      ? STARTUP_DELAY_MS
      : Math.max(MIN_DELAY_MS, this.intervalMs() + this.jitterMs());
    this.scheduleNext(delay);
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) return;
    if (this.timer) clearTimeout(this.timer);
    const clamped = Math.max(1_000, Math.round(delayMs));
    this.nextRunAt = new Date(this.now() + clamped).toISOString();
    void this.persistNextRun();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce('scheduler').finally(() => {
        if (this.stopping) return;
        // subtract the time the cycle consumed so ticks stay aligned with the configured interval
        const consumed = this.last ? this.last.duration_ms : 0;
        this.scheduleNext(Math.max(MIN_DELAY_MS, this.intervalMs() - consumed + this.jitterMs()));
      });
    }, clamped);
  }

  /** Executes a cycle unless one is already running (single flight). */
  async runOnce(trigger: 'scheduler' | 'startup' | 'manual'): Promise<CycleReport | null> {
    if (this.busy) {
      this.deps.logger.info('cycle skipped: one is already running', {
        event: LOG_EVENTS.CYCLE_SKIPPED,
        trigger,
        interval_minutes: this.deps.intervalMinutes,
      });
      return null;
    }
    this.busy = true;
    const startedAt = this.now();
    try {
      const report = await this.deps.runCycle({ trigger });
      this.last = report;
      this.lastResult = report.status;
      this.lastRunAt = new Date(startedAt).toISOString();
      if (report.status === 'completed') this.completed += 1;
      else this.failed += 1;
      return report;
    } catch (error) {
      this.failed += 1;
      this.lastResult = 'failed';
      this.deps.logger.error('cycle threw outside its own handler', {
        event: LOG_EVENTS.CYCLE_FAILED,
        ...errorFields(error),
      });
      return null;
    } finally {
      this.busy = false;
      await this.persistNextRun();
    }
  }

  /** Manual trigger from the internal API: re-anchors the periodic schedule afterwards. */
  async runNow(): Promise<{ started: boolean; report: CycleReport | null }> {
    if (this.busy) return { started: false, report: null };
    if (this.timer) clearTimeout(this.timer);
    const report = await this.runOnce('manual');
    if (!this.stopping) {
      const consumed = report?.duration_ms ?? 0;
      this.scheduleNext(Math.max(MIN_DELAY_MS, this.intervalMs() - consumed + this.jitterMs()));
    }
    return { started: report !== null, report };
  }

  status(): SchedulerStatus {
    return {
      running: this.busy,
      current_cycle_id: this.busy ? (this.last?.cycle_id ?? null) : null,
      next_run_at: this.nextRunAt,
      last_run_at: this.lastRunAt,
      last_result: this.lastResult,
      last_duration_ms: this.last?.duration_ms ?? null,
      cycles_completed: this.completed,
      cycles_failed: this.failed,
      started_at: this.startedAtIso,
      uptime_ms: Math.max(0, this.now() - this.startedAtMs),
      interval_minutes: this.deps.intervalMinutes,
      stopping: this.stopping,
    };
  }

  /** Stops the timer and waits (bounded) for an in-flight cycle to settle. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deps.logger.info('scheduler stopping', {
      event: LOG_EVENTS.WORKER_STOPPING,
      grace_ms: this.deps.shutdownGraceMs,
    });
    const deadline = this.now() + this.deps.shutdownGraceMs;
    while (this.busy && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (this.busy) {
      this.deps.logger.warn(
        'shutdown grace period exceeded; the cycle will be marked abandoned on restart',
        {
          event: LOG_EVENTS.WORKER_STOPPING,
        },
      );
    }
  }
}
