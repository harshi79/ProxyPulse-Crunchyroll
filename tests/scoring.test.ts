/**
 * Scoring rules: connectivity, freshness, service quality and the quarantine/expiry thresholds.
 * These numbers decide what the public pool looks like, so they are pinned here explicitly.
 */

import { describe, expect, it } from 'vitest';
import {
  combineScores,
  DEFAULT_SCORING_CONFIG,
  freshnessScore,
  isExpired,
  isPoolEligible,
  latencyScore,
  minutesSince,
  reliabilityScore,
  scoreProxy,
  scoreProxyDetailed,
  shouldQuarantine,
  type ScoreInput,
} from '@proxypulse/shared';
import {
  SERVICE_CONNECTIVITY_WEIGHT,
  serviceScore,
  shouldCheckService,
  statusForVerdict,
} from '@proxypulse/service-crunchyroll';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const fresh: ScoreInput = {
  validationPassed: true,
  latencyMs: 150,
  checkCount: 10,
  passCount: 10,
  consecutiveFailures: 0,
  minutesSinceLastPass: 1,
  serviceStatus: 'passed',
};

describe('latency scoring', () => {
  it('is full marks at or below the ideal latency and zero at the cap', () => {
    expect(latencyScore(null)).toBe(0);
    expect(latencyScore(0)).toBe(0);
    expect(latencyScore(DEFAULT_SCORING_CONFIG.idealLatencyMs)).toBe(1);
    expect(latencyScore(DEFAULT_SCORING_CONFIG.maxLatencyMs)).toBe(0);
    expect(latencyScore(DEFAULT_SCORING_CONFIG.maxLatencyMs + 1)).toBe(0);
  });

  it('falls off linearly between ideal and max', () => {
    const { idealLatencyMs, maxLatencyMs } = DEFAULT_SCORING_CONFIG;
    const mid = (idealLatencyMs + maxLatencyMs) / 2;
    expect(latencyScore(mid)).toBeCloseTo(0.5, 5);
  });
});

describe('freshness and reliability', () => {
  it('halves at the configured half-life', () => {
    expect(freshnessScore(0)).toBe(1);
    expect(freshnessScore(DEFAULT_SCORING_CONFIG.freshnessHalfLifeMinutes)).toBeCloseTo(0.5, 5);
    expect(freshnessScore(null)).toBe(0);
  });

  it('uses the historical pass rate, with a head start on the first success', () => {
    expect(reliabilityScore(0, 0, true)).toBe(0.5);
    expect(reliabilityScore(0, 0, false)).toBe(0);
    expect(reliabilityScore(4, 3, true)).toBeCloseTo(0.75, 5);
  });

  it('computes minutes since an ISO timestamp', () => {
    expect(minutesSince('2026-01-01T11:00:00.000Z', NOW)).toBe(60);
    expect(minutesSince(null, NOW)).toBeNull();
  });
});

describe('proxy score', () => {
  it('is zero when the last connectivity check failed', () => {
    expect(scoreProxy({ ...fresh, validationPassed: false })).toBe(0);
  });

  it('rewards a fast, reliable, service-verified proxy', () => {
    const score = scoreProxy({
      ...fresh,
      latencyMs: 120,
      serviceStatus: 'passed',
      anonymity: 'elite',
      sourceTrust: 0.9,
    });
    expect(score).toBeGreaterThanOrEqual(90);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('penalises consecutive failures and stale results', () => {
    const good = scoreProxy({ ...fresh, latencyMs: 150 });
    const failing = scoreProxy({ ...fresh, consecutiveFailures: 4, latencyMs: 150 });
    const stale = scoreProxy({
      ...fresh,
      latencyMs: 150,
      minutesSinceLastPass: 120,
      serviceStatus: 'untested',
    });
    expect(failing).toBeLessThan(good);
    expect(stale).toBeLessThan(good);
  });

  it('treats an untested service neutrally and a blocked service as unusable', () => {
    const untested = scoreProxy({ ...fresh, latencyMs: 150, serviceStatus: 'untested' });
    const passed = scoreProxy({ ...fresh, latencyMs: 150, serviceStatus: 'passed' });
    const blocked = scoreProxy({ ...fresh, latencyMs: 150, serviceStatus: 'blocked' });
    expect(passed).toBeGreaterThan(untested);
    expect(blocked).toBeLessThan(untested);
  });

  it('exposes the factors that produced the number', () => {
    const breakdown = scoreProxyDetailed({ ...fresh, latencyMs: 150 }, DEFAULT_SCORING_CONFIG);
    expect(breakdown.factors.reliability).toBe(1);
    expect(breakdown.factors.latency).toBeGreaterThan(0.5);
    expect(breakdown.factors.freshness).toBeGreaterThan(0.9);
    expect(breakdown.score).toBe(scoreProxy({ ...fresh, latencyMs: 150 }, DEFAULT_SCORING_CONFIG));
    expect(Number.isInteger(breakdown.score)).toBe(true);
    expect(Array.isArray(breakdown.reasons)).toBe(true);
  });
});

describe('combineScores', () => {
  it('keeps the connectivity score when no service verdict exists', () => {
    expect(combineScores(72, null)).toBe(72);
    expect(combineScores(72, null, { connectivityWeight: 0.9 })).toBe(72);
  });

  it('blends the service quality with the documented weight', () => {
    const weight = SERVICE_CONNECTIVITY_WEIGHT;
    const combined = combineScores(80, 1);
    expect(combined).toBe(Math.round((0.8 * weight + 1 * (1 - weight)) * 100));
    expect(combined).toBeGreaterThan(80);
    expect(combineScores(80, 0)).toBeLessThan(80);
  });

  it('clamps out-of-range inputs', () => {
    expect(combineScores(150, 2)).toBeLessThanOrEqual(100);
    expect(combineScores(-10, -1)).toBe(0);
  });
});

describe('quarantine and expiry', () => {
  it('quarantines at the consecutive failure threshold', () => {
    expect(shouldQuarantine(DEFAULT_SCORING_CONFIG.maxConsecutiveFailures - 1)).toBe(false);
    expect(shouldQuarantine(DEFAULT_SCORING_CONFIG.maxConsecutiveFailures)).toBe(true);
  });

  it('expires entries with no recent success', () => {
    const ttlMs = DEFAULT_SCORING_CONFIG.poolTtlMinutes * 60_000;
    expect(isExpired(new Date(NOW - ttlMs / 2).toISOString(), DEFAULT_SCORING_CONFIG, NOW)).toBe(
      false,
    );
    expect(
      isExpired(new Date(NOW - ttlMs - 1_000).toISOString(), DEFAULT_SCORING_CONFIG, NOW),
    ).toBe(true);
    expect(isExpired(null, DEFAULT_SCORING_CONFIG, NOW)).toBe(true);
    expect(isExpired('not-a-date', DEFAULT_SCORING_CONFIG, NOW)).toBe(true);
  });
});

describe('pool eligibility', () => {
  const base = {
    status: 'active',
    score: 80,
    last_passed_at: new Date(NOW - 60_000).toISOString(),
    service_status: 'passed' as const,
  };

  it('requires an active, fresh, above-threshold row', () => {
    expect(isPoolEligible(base, { requireServicePass: false, now: NOW })).toBe(true);
    expect(
      isPoolEligible({ ...base, status: 'quarantined' }, { requireServicePass: false, now: NOW }),
    ).toBe(false);
    expect(
      isPoolEligible({ ...base, score: 1 }, { requireServicePass: false, minScore: 25, now: NOW }),
    ).toBe(false);
    expect(
      isPoolEligible(
        { ...base, last_passed_at: new Date(NOW - 10 * 60_000).toISOString() },
        {
          requireServicePass: false,
          ttlMinutes: 5,
          now: NOW,
        },
      ),
    ).toBe(false);
  });

  it('honours the service requirement and latency filter', () => {
    expect(
      isPoolEligible(
        { ...base, service_status: 'untested' },
        { requireServicePass: true, now: NOW },
      ),
    ).toBe(false);
    expect(
      isPoolEligible(base, {
        requireServicePass: true,
        latencyMs: 900,
        maxLatencyMs: 500,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      isPoolEligible(base, {
        requireServicePass: true,
        latencyMs: 400,
        maxLatencyMs: 500,
        now: NOW,
      }),
    ).toBe(true);
  });
});

describe('service adapter scoring', () => {
  it('maps verdicts onto stored service statuses', () => {
    expect(statusForVerdict('passed')).toBe('passed');
    expect(statusForVerdict('blocked')).toBe('blocked');
    expect(statusForVerdict('skipped')).toBe('skipped');
    expect(statusForVerdict('failed')).toBe('failed');
  });

  it('scores a passing probe by latency and stability', () => {
    const fast = serviceScore({ verdict: 'passed', latencyMs: 120, consecutiveServiceFailures: 0 });
    const slow = serviceScore({
      verdict: 'passed',
      latencyMs: 4_000,
      consecutiveServiceFailures: 0,
    });
    expect(fast.quality).toBeGreaterThan(slow.quality);
    expect(fast.status).toBe('passed');
    expect(slow.reasons).toContain('slow_service_response');
  });

  it('keeps a neutral standing when nothing was checked', () => {
    expect(
      serviceScore({ verdict: 'skipped', latencyMs: null, consecutiveServiceFailures: 0 }).quality,
    ).toBe(0.5);
  });

  it('degrades repeated service failures but never below zero', () => {
    const first = serviceScore({
      verdict: 'failed',
      latencyMs: null,
      consecutiveServiceFailures: 1,
    });
    const later = serviceScore({
      verdict: 'failed',
      latencyMs: null,
      consecutiveServiceFailures: 5,
    });
    expect(later.quality).toBeLessThan(first.quality);
    expect(later.quality).toBeGreaterThanOrEqual(0);
  });

  it('only spends a service request on proxies worth it', () => {
    expect(
      shouldCheckService({
        score: 5,
        serviceStatus: 'untested',
        minScore: 10,
        allowRetestBlocked: false,
      }),
    ).toBe(false);
    expect(
      shouldCheckService({
        score: 50,
        serviceStatus: 'passed',
        minScore: 10,
        allowRetestBlocked: false,
      }),
    ).toBe(false);
    expect(
      shouldCheckService({
        score: 50,
        serviceStatus: 'untested',
        minScore: 10,
        allowRetestBlocked: false,
      }),
    ).toBe(true);
    expect(
      shouldCheckService({
        score: 50,
        serviceStatus: 'blocked',
        minScore: 10,
        allowRetestBlocked: false,
      }),
    ).toBe(false);
    expect(
      shouldCheckService({
        score: 50,
        serviceStatus: 'blocked',
        minScore: 10,
        allowRetestBlocked: true,
      }),
    ).toBe(true);
  });
});
