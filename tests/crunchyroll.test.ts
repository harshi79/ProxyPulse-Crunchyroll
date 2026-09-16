/**
 * The authorised service adapter: how a probe response turns into a verdict, and the polite-request
 * guarantees (rate limits, robots.txt, no evasion, no credentials, no login paths).
 */

import { describe, expect, it } from 'vitest';
import {
  createLogger,
  type ProxyEndpoint,
  type ProxyRequester,
  type ProxyResponse,
} from '@proxypulse/shared';
import {
  CrunchyrollChecker,
  DEFAULT_CRUNCHYROLL_CONFIG,
  containsBlockMarker,
  evaluateProbedResponse,
  parseRetryAfterMs,
  probeHeaders,
  type CrunchyrollCheckConfig,
} from '@proxypulse/service-crunchyroll';

const PROXY: ProxyEndpoint = { host: 'proxy.example', port: 8080, protocol: 'http' };

interface Recorded {
  endpoint: ProxyEndpoint;
  url: string;
  headers: Record<string, string>;
}

function makeChecker(
  responses: Array<Partial<ProxyResponse> | ((call: Recorded) => Partial<ProxyResponse>)>,
  overrides: Partial<CrunchyrollCheckConfig> = {},
  options: { robots?: string; nowStart?: number; fallback?: Partial<ProxyResponse> } = {},
) {
  const calls: Recorded[] = [];
  let clock = options.nowStart ?? 1_700_000_000_000;
  let index = 0;
  const requester: ProxyRequester = {
    async request(endpoint, url, init) {
      const record: Recorded = { endpoint, url, headers: { ...(init?.headers ?? {}) } };
      calls.push(record);
      const next = index < responses.length ? responses[index] : options.fallback;
      index += 1;
      const base: ProxyResponse = {
        ok: true,
        status: 200,
        headers: {},
        bodyBytes: 24,
        bodyText: 'User-agent: *\nAllow: /',
        truncated: false,
        latencyMs: 150,
      };
      const partial = typeof next === 'function' ? next(record) : next;
      return { ...base, ...(partial ?? {}) };
    },
  };
  const direct = async () => ({ status: 200, text: options.robots ?? 'User-agent: *\nAllow: /' });
  const checker = new CrunchyrollChecker({
    requester,
    direct,
    logger: createLogger({ name: 'test', level: 'error' }),
    now: () => clock,
    config: {
      ...DEFAULT_CRUNCHYROLL_CONFIG,
      allowedHosts: ['www.crunchyroll.com'],
      checkUrl: 'https://www.crunchyroll.com/robots.txt',
      minRequestSpacingMs: 0,
      rateLimitPerMinute: 100_000,
      maxChecksPerCycle: 100,
      ...overrides,
    },
  });
  return {
    checker,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
    reset: () => {
      index = 0;
      calls.length = 0;
    },
  };
}

const check = (checker: CrunchyrollChecker, proxy: ProxyEndpoint = PROXY) =>
  checker.check(proxy, { proxy_id: 1, cycle_id: 'cyc_test' });

describe('response rules', () => {
  it('accepts a clean 200 from the allowed host', async () => {
    const { checker, calls } = makeChecker([]);
    const result = await check(checker);
    expect(result.verdict).toBe('passed');
    expect(result.status).toBe('passed');
    expect(result.passed).toBe(true);
    expect(result.latency_ms).toBe(150);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? '').hostname).toBe('www.crunchyroll.com');
  });

  it('separates a broken proxy from a refusing service', () => {
    const outcome = (response: Partial<ProxyResponse>) =>
      evaluateProbedResponse({
        response: {
          ok: false,
          status: 0,
          headers: {},
          bodyBytes: 0,
          bodyText: '',
          truncated: false,
          latencyMs: 10,
          ...response,
        } as ProxyResponse,
        checkPath: '/robots.txt',
        robotsAllowed: true,
        robotsReason: 'allowed',
        expectedHost: 'www.crunchyroll.com',
      });
    expect(outcome({ error: { code: 'connect_refused', message: 'x' } }).reason).toBe(
      'proxy_error:connect_refused',
    );
    expect(outcome({ error: { code: 'timeout', message: 'x' } }).reason).toBe(
      'transport_error:timeout',
    );
    expect(outcome({ error: { code: 'blocked_by_policy', message: 'x' } }).verdict).toBe('skipped');
  });

  it('maps throttling and refusals to blocked verdicts, never to a pass', async () => {
    for (const [status, reason] of [
      [429, 'rate_limited:429'],
      [503, 'rate_limited:503'],
      [403, 'denied:403'],
      [451, 'denied:451'],
      [407, 'denied:407'],
    ] as const) {
      const { checker } = makeChecker([{ status, bodyText: 'nope', ok: false }]);
      const result = await check(checker);
      expect(result.verdict, `status ${status}`).toBe('blocked');
      expect(result.reason, `status ${status}`).toBe(reason);
      expect(result.status).toBe('blocked');
    }
  });

  it('recognises an interstitial challenge page even with a 200', async () => {
    const { checker } = makeChecker([
      { status: 200, bodyText: '<html>Just a moment... checking your browser</html>' },
    ]);
    const result = await check(checker);
    expect(result.verdict).toBe('blocked');
    expect(result.reason).toBe('bot_challenge');
  });

  it('marks unexpected content as a failure', async () => {
    const { checker } = makeChecker([
      { status: 200, bodyText: 'this is not the file you are looking for' },
    ]);
    const result = await check(checker);
    expect(result.reason).toBe('unexpected_content');
  });

  it('detects block markers and honours Retry-After', () => {
    expect(containsBlockMarker('Please Enable JavaScript and cookies')).toBe(
      'enable javascript and cookies',
    );
    expect(containsBlockMarker('totally normal page')).toBeNull();
    expect(parseRetryAfterMs('30')).toBe(30_000);
    const future = Date.now() + 60_000;
    expect(parseRetryAfterMs(new Date(future).toUTCString())).toBeGreaterThanOrEqual(50_000);
    expect(parseRetryAfterMs(undefined)).toBeNull();
  });
});

describe('politeness and safety guarantees', () => {
  it('sends a plain identity and nothing that impersonates a user', async () => {
    const { checker, calls } = makeChecker([]);
    await check(checker);
    const headers = calls[0]?.headers ?? {};
    // A polite, static identity and nothing else: no cookies, no forged client addresses.
    expect(Object.keys(headers).sort()).toEqual([
      'accept',
      'accept-language',
      'cache-control',
      'user-agent',
    ]);
    expect(headers['user-agent']).toBe(DEFAULT_CRUNCHYROLL_CONFIG.userAgent);
    for (const forbidden of [
      'cookie',
      'authorization',
      'proxy-authorization',
      'x-forwarded-for',
      'x-real-ip',
    ]) {
      expect(headers[forbidden], forbidden).toBeUndefined();
    }
  });

  it('never probes authentication, API or DRM paths, only the configured endpoint', async () => {
    const { checker, calls } = makeChecker([]);
    await check(checker);
    const path = new URL(calls[0]?.url ?? '').pathname;
    expect(path).toBe('/robots.txt');
    expect(/login|signin|account|api|drm|v3\//i.test(path)).toBe(false);
    const headers = probeHeaders(DEFAULT_CRUNCHYROLL_CONFIG.userAgent);
    expect(Object.keys(headers)).not.toContain('authorization');
  });

  it('refuses a probe URL outside the host allow-list', async () => {
    const { checker, calls } = makeChecker([], { checkUrl: 'https://evil.example.com/robots.txt' });
    const result = await check(checker);
    expect(result.verdict).toBe('skipped');
    expect(result.reason).toContain('not in the allow-list');
    expect(calls).toHaveLength(0);
  });

  it('stops probing when the whole cycle budget is spent', async () => {
    const { checker, calls } = makeChecker([], { maxChecksPerCycle: 2 });
    checker.beginCycle('cyc_test');
    await check(checker);
    await check(checker);
    const third = await check(checker);
    expect(third.reason).toBe('cycle_budget_exhausted');
    expect(calls).toHaveLength(2);
  });

  it('backs off globally when the service asks us to slow down', async () => {
    const { checker, calls, advance } = makeChecker([
      { status: 429, headers: { 'retry-after': '120' }, bodyText: '' },
    ]);
    const first = await check(checker);
    expect(first.retry_after_ms).toBe(120_000);
    const second = await check(checker);
    expect(second.reason).toBe('rate_cooldown');
    expect(second.verdict).toBe('skipped');
    expect(calls).toHaveLength(1);
    advance(130_000);
    const third = await check(checker);
    expect(third.verdict).toBe('passed');
  });

  it('opens the circuit breaker instead of hammering a failing target', async () => {
    const { checker, calls, advance } = makeChecker(
      [],
      {},
      { fallback: { ok: false, status: 0, error: { code: 'connect_reset', message: 'reset' } } },
    );
    let skippedByBreaker = false;
    for (let i = 0; i < 40; i++) {
      advance(1_000);
      const result = await check(checker);
      if (result.reason === 'circuit_open') {
        skippedByBreaker = true;
        break;
      }
    }
    expect(skippedByBreaker).toBe(true);
    // the breaker trips at the failure threshold instead of 40 more probes going out
    expect(calls.length).toBeLessThanOrEqual(30);
    expect(checker.stats.checks).toBeLessThanOrEqual(30);
  });

  it('checks robots.txt once per cycle and fails closed when it is disallowed', async () => {
    const { checker, calls } = makeChecker([], {}, { robots: 'User-agent: *\nDisallow: /' });
    const result = await check(checker);
    expect(result.verdict).toBe('skipped');
    expect(result.reason).toContain('robots_disallowed');
    expect(result.robots.allowed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('never throws: a broken requester becomes a failed verdict', async () => {
    const { checker } = makeChecker([]);
    const broken = new CrunchyrollChecker({
      requester: {
        async request() {
          throw new Error('socket exploded');
        },
      },
      direct: async () => ({ status: 200, text: 'User-agent: *\nAllow: /' }),
      logger: createLogger({ name: 'test', level: 'error' }),
      config: {
        ...DEFAULT_CRUNCHYROLL_CONFIG,
        minRequestSpacingMs: 0,
        checkUrl: 'https://www.crunchyroll.com/robots.txt',
      },
    });
    void checker;
    const result = await broken.check(PROXY, { proxy_id: 2, cycle_id: 'cyc_test' });
    expect(result.verdict).toBe('failed');
    expect(result.reason).toBe('requester_error');
    expect(result.details.error).toBe('socket exploded');
  });

  it('reports per-cycle stats without leaking identifiers', async () => {
    const { checker, advance } = makeChecker([{ status: 429, bodyText: '' }, {}]);
    checker.beginCycle('cyc_stats');
    await check(checker);
    // the 429 installs a global cooldown; step past it before the second probe
    advance(61_000);
    await check(checker);
    const stats = checker.stats;
    expect(stats.cycle_id).toBe('cyc_stats');
    expect(stats.checks).toBe(2);
    expect(stats.blocked).toBe(1);
    expect(stats.probe_url).toBe('https://www.crunchyroll.com/robots.txt');
    expect(JSON.stringify(stats)).not.toContain('password');
  });
});
