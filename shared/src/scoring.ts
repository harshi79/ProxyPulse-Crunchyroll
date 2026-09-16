/**
 * Proxy scoring + pool eligibility rules. Pure functions so the worker, the pool selector and the
 * tests all agree on one definition of "healthy".
 */

import { type AnonymityLevel, type ServiceStatus } from './types.js';

export interface ScoringConfig {
  /** Latency at or below this gets full credit. */
  idealLatencyMs: number;
  /** Latency at or above this gets zero credit. */
  maxLatencyMs: number;
  reliabilityWeight: number;
  latencyWeight: number;
  freshnessWeight: number;
  serviceWeight: number;
  qualityWeight: number;
  /** Exponential decay half-life for "how long since it last worked". */
  freshnessHalfLifeMinutes: number;
  /** Consecutive failures before a proxy is quarantined out of the public pool. */
  maxConsecutiveFailures: number;
  /** Points removed per consecutive failure. */
  failurePenaltyPoints: number;
  /** A proxy with no successful check for this long expires from the pool. */
  poolTtlMinutes: number;
  /** Minimum score required to enter/remain in the public pool. */
  minPoolScore: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  idealLatencyMs: 200,
  maxLatencyMs: 3000,
  reliabilityWeight: 0.35,
  latencyWeight: 0.2,
  freshnessWeight: 0.15,
  serviceWeight: 0.25,
  qualityWeight: 0.05,
  freshnessHalfLifeMinutes: 45,
  maxConsecutiveFailures: 3,
  failurePenaltyPoints: 12,
  poolTtlMinutes: 90,
  minPoolScore: 25,
};

export interface ScoreInput {
  /** Did the most recent basic connectivity validation succeed? */
  validationPassed: boolean;
  latencyMs: number | null;
  checkCount: number;
  passCount: number;
  consecutiveFailures: number;
  /** Minutes since the last successful check; null when it never succeeded. */
  minutesSinceLastPass: number | null;
  serviceStatus: ServiceStatus;
  serviceBlocked?: boolean;
  sourceTrust?: number | undefined;
  anonymity?: AnonymityLevel | undefined;
}

export interface ScoreBreakdown {
  score: number;
  factors: {
    reliability: number;
    latency: number;
    freshness: number;
    service: number;
    quality: number;
    penalty: number;
  };
  reasons: string[];
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

const SERVICE_SCORES: Record<ServiceStatus, number> = {
  passed: 1,
  untested: 0.45,
  skipped: 0.3,
  failed: 0.1,
  blocked: 0,
};

const ANONYMITY_SCORES: Record<AnonymityLevel, number> = {
  elite: 1,
  anonymous: 0.75,
  transparent: 0.4,
  unknown: 0.6,
};

export function latencyScore(
  latencyMs: number | null,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): number {
  if (latencyMs === null || !Number.isFinite(latencyMs) || latencyMs <= 0) return 0;
  if (latencyMs <= config.idealLatencyMs) return 1;
  if (latencyMs >= config.maxLatencyMs) return 0;
  return clamp01((config.maxLatencyMs - latencyMs) / (config.maxLatencyMs - config.idealLatencyMs));
}

export function freshnessScore(
  minutesSinceLastPass: number | null,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): number {
  if (minutesSinceLastPass === null || !Number.isFinite(minutesSinceLastPass)) return 0;
  if (minutesSinceLastPass <= 0) return 1;
  return clamp01(0.5 ** (minutesSinceLastPass / config.freshnessHalfLifeMinutes));
}

export function reliabilityScore(
  checkCount: number,
  passCount: number,
  validationPassed: boolean,
): number {
  if (checkCount <= 0) return validationPassed ? 0.5 : 0;
  return clamp01(passCount / checkCount);
}

/** Full breakdown; `scoreProxy` is just `scoreProxyDetailed(...).score`. */
export function scoreProxyDetailed(
  input: ScoreInput,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): ScoreBreakdown {
  const reasons: string[] = [];

  if (!input.validationPassed) {
    reasons.push('validation_failed');
    return {
      score: 0,
      factors: { reliability: 0, latency: 0, freshness: 0, service: 0, quality: 0, penalty: 0 },
      reasons,
    };
  }

  const reliability = reliabilityScore(input.checkCount, input.passCount, input.validationPassed);
  const latency = latencyScore(input.latencyMs, config);
  const freshness = freshnessScore(input.minutesSinceLastPass, config);
  const service = clamp01(SERVICE_SCORES[input.serviceStatus] ?? 0.3);
  const trust = clamp01(input.sourceTrust ?? 0.5);
  const quality = clamp01(trust * 0.6 + ANONYMITY_SCORES[input.anonymity ?? 'unknown'] * 0.4);

  let penalty = Math.min(
    40,
    Math.max(0, input.consecutiveFailures - 1) * config.failurePenaltyPoints +
      (input.consecutiveFailures > 0 ? config.failurePenaltyPoints / 2 : 0),
  );
  if (input.serviceBlocked) {
    penalty += 25;
    reasons.push('service_blocked');
  }
  penalty = Math.min(60, penalty);

  const weighted =
    config.reliabilityWeight * reliability +
    config.latencyWeight * latency +
    config.freshnessWeight * freshness +
    config.serviceWeight * service +
    config.qualityWeight * quality;

  const sum =
    config.reliabilityWeight +
    config.latencyWeight +
    config.freshnessWeight +
    config.serviceWeight +
    config.qualityWeight;

  const score = Math.round(clamp((weighted / sum) * 100 - penalty, 0, 100));
  if (penalty > 0) reasons.push(`failure_penalty:${input.consecutiveFailures}`);
  if (score < config.minPoolScore) reasons.push('below_min_pool_score');

  return {
    score,
    factors: {
      reliability: Number(reliability.toFixed(3)),
      latency: Number(latency.toFixed(3)),
      freshness: Number(freshness.toFixed(3)),
      service: Number(service.toFixed(3)),
      quality: Number(quality.toFixed(3)),
      penalty,
    },
    reasons,
  };
}

export function scoreProxy(
  input: ScoreInput,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): number {
  return scoreProxyDetailed(input, config).score;
}

export function shouldQuarantine(
  consecutiveFailures: number,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): boolean {
  return consecutiveFailures >= config.maxConsecutiveFailures;
}

export function isExpired(
  lastPassedAt: string | null,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
  now: number = Date.now(),
): boolean {
  if (!lastPassedAt) return true;
  const ts = Date.parse(lastPassedAt);
  if (!Number.isFinite(ts)) return true;
  return now - ts > config.poolTtlMinutes * 60_000;
}

export function minutesSince(iso: string | null, now: number = Date.now()): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return (now - ts) / 60_000;
}

/** Pool eligibility: healthy status + fresh success + enough score. */
export interface EligibilityInput {
  status: string;
  score: number;
  last_passed_at: string | null;
  service_status: ServiceStatus;
}

export interface EligibilityOptions {
  requireServicePass: boolean;
  minScore?: number;
  maxLatencyMs?: number | null;
  latencyMs?: number | null;
  ttlMinutes?: number;
  now?: number;
}

export function isPoolEligible(record: EligibilityInput, options: EligibilityOptions): boolean {
  const config = {
    ...DEFAULT_SCORING_CONFIG,
    poolTtlMinutes: options.ttlMinutes ?? DEFAULT_SCORING_CONFIG.poolTtlMinutes,
  };
  if (record.status !== 'active') return false;
  if (record.score < (options.minScore ?? config.minPoolScore)) return false;
  if (isExpired(record.last_passed_at, config, options.now ?? Date.now())) return false;
  if (options.requireServicePass && record.service_status !== 'passed') return false;
  const maxLatency = options.maxLatencyMs ?? null;
  if (
    maxLatency !== null &&
    typeof options.latencyMs === 'number' &&
    options.latencyMs > maxLatency
  )
    return false;
  return true;
}

export interface CombineScoreOptions {
  /** Weight of the connectivity score (0..1); the service factor gets the remainder. */
  connectivityWeight: number;
}

/**
 * Final pool score: connectivity plus the service adapter's quality factor.
 * `serviceQuality === null` means "no service verdict available" (checks disabled or budget spent),
 * in which case the connectivity score stands on its own so the pool never empties by policy.
 */
export function combineScores(
  connectivityScore: number,
  serviceQuality: number | null,
  options: Partial<CombineScoreOptions> = {},
): number {
  const weight = Math.min(1, Math.max(0, options.connectivityWeight ?? 0.55));
  const base = Math.min(1, Math.max(0, connectivityScore / 100));
  if (serviceQuality === null) return Math.round(base * 100);
  const quality = Math.min(1, Math.max(0, serviceQuality));
  return Math.round(Math.min(1, Math.max(0, base * weight + quality * (1 - weight))) * 100);
}
