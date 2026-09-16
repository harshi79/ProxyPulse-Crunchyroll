/**
 * Service-side scoring. Turns a probe verdict into a 0..1 quality factor and combines it with the
 * connectivity score computed by the worker.
 */

import { type ServiceStatus } from '@proxypulse/shared';

import { type CrunchyrollVerdict } from './types.js';

export interface ServiceScoreInput {
  verdict: CrunchyrollVerdict;
  latencyMs: number | null;
  /** Consecutive service-check failures for this proxy (not connectivity failures). */
  consecutiveServiceFailures: number;
  /** Ideal/cap latency for the service probe, used for the latency component. */
  idealLatencyMs?: number;
  maxLatencyMs?: number;
}

export interface ServiceScore {
  quality: number;
  status: ServiceStatus;
  reasons: string[];
}

export function statusForVerdict(verdict: CrunchyrollVerdict): ServiceStatus {
  switch (verdict) {
    case 'passed':
      return 'passed';
    case 'blocked':
      return 'blocked';
    case 'skipped':
      return 'skipped';
    default:
      return 'failed';
  }
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

export function serviceScore(input: ServiceScoreInput): ServiceScore {
  const reasons: string[] = [];
  const ideal = input.idealLatencyMs ?? 400;
  const max = input.maxLatencyMs ?? 5_000;

  if (input.verdict === 'passed') {
    const latency = input.latencyMs;
    const latencyFactor =
      latency === null || !Number.isFinite(latency)
        ? 0.6
        : clamp01((max - latency) / (max - Math.max(1, ideal - 1)));
    const stability = clamp01(1 - 0.25 * Math.max(0, input.consecutiveServiceFailures - 0));
    const quality = clamp01(0.7 + 0.2 * latencyFactor + 0.1 * stability);
    if (latencyFactor < 0.4) reasons.push('slow_service_response');
    return { quality, status: 'passed', reasons };
  }
  if (input.verdict === 'blocked') {
    return { quality: 0.05, status: 'blocked', reasons: ['service_blocked_proxy'] };
  }
  if (input.verdict === 'skipped') {
    // No verdict this cycle: keep the previous standing roughly intact (neutral, slightly reduced).
    return { quality: 0.5, status: 'skipped', reasons: ['no_service_verdict'] };
  }
  const penalty = Math.min(0.3, 0.1 * Math.max(0, input.consecutiveServiceFailures - 1));
  return {
    quality: Math.max(0, 0.1 - penalty),
    status: 'failed',
    reasons: ['service_check_failed'],
  };
}

/** Weight used when combining the connectivity score with this adapter's quality factor. */
export const SERVICE_CONNECTIVITY_WEIGHT = 0.55;

/** True when a proxy is worth spending one of the (rate limited) service requests on. */
export function shouldCheckService(input: {
  score: number;
  serviceStatus: ServiceStatus;
  minScore: number;
  allowRetestBlocked: boolean;
}): boolean {
  if (input.score < input.minScore) return false;
  if (input.serviceStatus === 'passed') return false;
  if (input.serviceStatus === 'blocked' && !input.allowRetestBlocked) return false;
  return true;
}

/**
 * Circuit breaker for the whole service: if most probes fail with transport/service errors the
 * target is probably degraded, so we stop probing instead of hammering it for the rest of the cycle.
 */
export class ServiceCircuitBreaker {
  private failures = 0;
  private successes = 0;
  private openUntil = 0;

  constructor(
    private readonly options: { failureThreshold: number; resetMs: number; now: () => number } = {
      failureThreshold: 25,
      resetMs: 120_000,
      now: () => Date.now(),
    },
  ) {}

  get open(): boolean {
    return this.options.now() < this.openUntil;
  }

  record(success: boolean): void {
    if (success) {
      this.successes += 1;
      this.failures = Math.max(0, this.failures - 2);
      if (this.failures < this.options.failureThreshold / 2) this.openUntil = 0;
      return;
    }
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) {
      this.openUntil = this.options.now() + this.options.resetMs;
      this.failures = 0;
    }
  }

  snapshot(): { failures: number; successes: number; open: boolean } {
    return { failures: this.failures, successes: this.successes, open: this.open };
  }
}
