/**
 * Crunchyroll compatibility checker.
 *
 * One small, unauthenticated, robots-approved GET per proxy, issued through that proxy, with a
 * token bucket + minimum spacing + per-cycle cap + cooldown on Retry-After. That is the whole
 * contract: it measures whether a proxy can complete a legitimate public request. Anything that
 * would require bypassing geo-blocking, bot protection, CAPTCHAs or authentication is out of scope
 * by design — such a result would not be a legal or fair signal anyway, and this adapter must never
 * grow into that.
 */

import {
  checkUrlPolicy,
  evaluateRobots,
  formatProxyRedacted,
  sleep,
  TokenBucket,
  type ProxyEndpoint,
  type ProxyRequester,
  type ProxyResponse,
  redactText,
} from '@proxypulse/shared';

import { evaluateProbedResponse, parseRetryAfterMs, probeHeaders } from './rules.js';
import { ServiceCircuitBreaker, statusForVerdict } from './scorer.js';
import {
  DEFAULT_CRUNCHYROLL_CONFIG,
  type CheckContext,
  type CheckerDeps,
  type CrunchyrollCheckConfig,
  type CrunchyrollCheckResult,
  type CrunchyrollVerdict,
  SERVICE_NAME,
} from './types.js';

interface RobotsState {
  fetched_at: number;
  checked: boolean;
  allowed: boolean;
  reason: string;
  crawl_delay_ms: number | null;
}

export interface CheckerStats {
  service: string;
  enabled: boolean;
  cycle_id: string | null;
  probe_url: string;
  checks: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  in_cooldown: boolean;
  circuit: { failures: number; successes: number; open: boolean };
  robots: { checked: boolean; allowed: boolean; reason: string } | null;
}

export class CrunchyrollChecker {
  readonly service = SERVICE_NAME;
  readonly config: CrunchyrollCheckConfig;

  private readonly requester: ProxyRequester;
  private readonly direct: CheckerDeps['direct'];
  private readonly logger: CheckerDeps['logger'];
  private readonly now: () => number;
  private readonly bucket: TokenBucket;
  private readonly breaker: ServiceCircuitBreaker;

  private robots: RobotsState | null = null;
  private lastRequestAt = 0;
  private spacingMs: number;
  private cooldownUntil = 0;
  private cycleId: string | null = null;
  private checksThisCycle = 0;
  private totals = { checks: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 };

  constructor(deps: CheckerDeps) {
    this.config = { ...DEFAULT_CRUNCHYROLL_CONFIG, ...deps.config };
    this.requester = deps.requester;
    this.direct = deps.direct;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => Date.now());
    this.spacingMs = this.config.minRequestSpacingMs;
    const perMinute = Math.max(1, this.config.rateLimitPerMinute);
    this.bucket = new TokenBucket(Math.min(10, perMinute), perMinute / 60, this.now);
    this.breaker = new ServiceCircuitBreaker({
      failureThreshold: 25,
      resetMs: 120_000,
      now: this.now,
    });
  }

  /** Called by the pipeline at cycle start: resets per-cycle budgets. */
  beginCycle(cycleId: string): void {
    this.cycleId = cycleId;
    this.checksThisCycle = 0;
    this.logger.debug('service check budget reset', {
      event: 'SERVICE_CHECK_STARTED',
      service: this.service,
      cycle_id: cycleId,
      max_checks_per_cycle: this.config.maxChecksPerCycle,
      rate_limit_per_minute: this.config.rateLimitPerMinute,
    });
  }

  get stats(): CheckerStats {
    return {
      service: this.service,
      enabled: this.config.enabled,
      cycle_id: this.cycleId,
      probe_url: this.probeUrlOrError().url?.toString() ?? 'invalid',
      ...this.totals,
      checks: this.totals.checks,
      in_cooldown: this.now() < this.cooldownUntil,
      circuit: this.breaker.snapshot(),
      robots: this.robots
        ? { checked: this.robots.checked, allowed: this.robots.allowed, reason: this.robots.reason }
        : null,
    };
  }

  private probeUrlOrError(): { url: URL | null; error: string | null } {
    const configured =
      this.config.checkUrl ??
      `${this.config.scheme}://${this.config.allowedHosts[0] ?? 'www.crunchyroll.com'}${this.config.checkPath}`;
    // The probe host must be on the operator's allow-list. Only then may it be a private/loopback
    // address, which is what the offline demo and the test-suite point this adapter at.
    let probeHost = '';
    try {
      probeHost = new URL(configured).hostname.toLowerCase();
    } catch {
      probeHost = '';
    }
    const listed =
      probeHost.length > 0 &&
      this.config.allowedHosts.some(
        (candidate) => probeHost === candidate || probeHost.endsWith(`.${candidate}`),
      );
    const verdict = checkUrlPolicy(configured, {
      allowedProtocols: this.config.scheme === 'https' ? ['https:'] : ['https:', 'http:'],
      blockMetadata: true,
      ...(listed ? { allowPrivate: true } : {}),
    });
    if (!verdict.ok) return { url: null, error: `probe url rejected: ${verdict.reason}` };
    const host = verdict.url.hostname.toLowerCase();
    const allowed = this.config.allowedHosts.some(
      (candidate) => host === candidate || host.endsWith(`.${candidate}`),
    );
    if (!allowed) return { url: null, error: `probe host "${host}" is not in the allow-list` };
    if (verdict.url.pathname === '/' || verdict.url.pathname.length === 0) {
      return { url: null, error: 'probe path must not be the site root' };
    }
    return { url: verdict.url, error: null };
  }

  private skipped(
    reason: string,
    extra: Partial<CrunchyrollCheckResult> = {},
  ): CrunchyrollCheckResult {
    this.totals.skipped += 1;
    return {
      service: this.service,
      passed: false,
      status: 'skipped',
      verdict: 'skipped',
      http_status: null,
      latency_ms: null,
      reason,
      details: {},
      retry_after_ms: null,
      robots: {
        checked: this.robots?.checked ?? false,
        allowed: this.robots?.allowed ?? true,
        reason: this.robots?.reason ?? 'not_checked',
        crawl_delay_ms: this.robots?.crawl_delay_ms ?? null,
      },
      ...extra,
    };
  }

  /** robots.txt is fetched once per TTL, directly (not via a proxy): it governs *our* crawler. */
  private async ensureRobots(url: URL): Promise<RobotsState> {
    if (this.robots && this.now() - this.robots.fetched_at < this.config.robotsCacheTtlMs)
      return this.robots;
    if (!this.config.respectRobots) {
      this.robots = {
        fetched_at: this.now(),
        checked: false,
        allowed: true,
        reason: 'robots_check_disabled',
        crawl_delay_ms: null,
      };
      return this.robots;
    }
    const robotsUrl = `${url.origin}/robots.txt`;
    const result = await this.direct(robotsUrl, {
      headers: { 'user-agent': this.config.userAgent, accept: 'text/plain' },
      timeoutMs: Math.min(10_000, this.config.timeoutMs),
    });
    const decision = evaluateRobots(
      url.pathname,
      this.config.userAgent,
      result.error
        ? { status: 0, text: '', error: true }
        : { status: result.status, text: result.text },
    );
    if (decision.allowed) {
      // honour Crawl-delay by widening the spacing between probes
      const crawlDelay =
        decision.crawlDelaySeconds === null ? 0 : decision.crawlDelaySeconds * 1000;
      this.spacingMs = Math.max(this.config.minRequestSpacingMs, crawlDelay);
    }
    this.robots = {
      fetched_at: this.now(),
      checked: true,
      allowed: decision.allowed,
      reason: decision.reason,
      crawl_delay_ms:
        decision.crawlDelaySeconds === null ? null : decision.crawlDelaySeconds * 1000,
    };
    this.logger.info('robots policy loaded', {
      event: 'SERVICE_CHECK_STARTED',
      service: this.service,
      robots_allowed: this.robots.allowed,
      robots_reason: this.robots.reason,
      spacing_ms: this.spacingMs,
    });
    return this.robots;
  }

  /** Runs one compatibility probe for one proxy. Never throws: failures become verdicts. */
  async check(endpoint: ProxyEndpoint, context: CheckContext): Promise<CrunchyrollCheckResult> {
    const base = { proxy_id: context.proxy_id, cycle_id: context.cycle_id };
    const robotsFor = (state: RobotsState | null) => ({
      checked: state?.checked ?? false,
      allowed: state?.allowed ?? true,
      reason: state?.reason ?? 'not_checked',
      crawl_delay_ms: state?.crawl_delay_ms ?? null,
    });

    if (!this.config.enabled) return this.skipped('service_checks_disabled', base);

    const target = this.probeUrlOrError();
    if (!target.url || target.error) return this.skipped(target.error ?? 'invalid_probe_url', base);

    if (this.now() < this.cooldownUntil) return this.skipped('rate_cooldown', base);
    if (this.breaker.open) return this.skipped('circuit_open', base);
    if (this.checksThisCycle >= this.config.maxChecksPerCycle)
      return this.skipped('cycle_budget_exhausted', base);
    if (!this.bucket.tryTake(1)) return this.skipped('rate_budget_exhausted', base);

    const robots = await this.ensureRobots(target.url);
    if (!robots.allowed) {
      return {
        ...this.skipped(`robots_disallowed:${robots.reason}`, base),
        robots: robotsFor(robots),
      };
    }

    const sinceLast = this.now() - this.lastRequestAt;
    if (sinceLast < this.spacingMs) await sleep(this.spacingMs - sinceLast);
    this.lastRequestAt = this.now();
    this.checksThisCycle += 1;
    this.totals.checks += 1;

    let response: ProxyResponse;
    try {
      response = await this.requester.request(endpoint, target.url.toString(), {
        method: 'GET',
        headers: probeHeaders(this.config.userAgent),
        timeoutMs: this.config.timeoutMs,
        maxResponseBytes: 64 * 1024,
        includeBody: true,
      });
    } catch (error) {
      this.breaker.record(false);
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...base,
        service: this.service,
        passed: false,
        status: 'failed',
        verdict: 'failed',
        http_status: null,
        latency_ms: null,
        reason: 'requester_error',
        details: { error: redactText(message).slice(0, 160) },
        retry_after_ms: null,
        robots: robotsFor(robots),
      };
    }

    const outcome = evaluateProbedResponse({
      response,
      checkPath: target.url.pathname,
      robotsAllowed: robots.allowed,
      robotsReason: robots.reason,
      expectedHost: target.url.hostname,
    });

    const verdict: CrunchyrollVerdict = outcome.verdict;
    if (verdict === 'blocked' || verdict === 'failed') this.breaker.record(false);
    else this.breaker.record(true);
    this.totals[verdict] += 1;

    const retryAfterMs =
      outcome.retryAfterMs ??
      parseRetryAfterMs(response.headers['retry-after'], this.now()) ??
      (verdict === 'blocked' ? 60_000 : null);
    if (retryAfterMs && retryAfterMs > 0) {
      // Respect the service: pause all probing (not just this proxy) for the requested backoff.
      this.cooldownUntil = this.now() + Math.min(retryAfterMs, 5 * 60_000);
    }

    const result: CrunchyrollCheckResult = {
      ...base,
      service: this.service,
      passed: verdict === 'passed',
      status: statusForVerdict(verdict),
      verdict,
      http_status: response.status === 0 ? null : response.status,
      latency_ms: response.latencyMs,
      reason: outcome.reason,
      details: outcome.details,
      retry_after_ms: retryAfterMs,
      robots: robotsFor(robots),
    };

    this.logger.debug('service probe completed', {
      event: 'SERVICE_CHECK_COMPLETED',
      service: this.service,
      proxy: formatProxyRedacted(endpoint),
      proxy_id: context.proxy_id,
      cycle_id: context.cycle_id,
      verdict,
      reason: outcome.reason,
      latency_ms: response.latencyMs,
    });
    return result;
  }
}
