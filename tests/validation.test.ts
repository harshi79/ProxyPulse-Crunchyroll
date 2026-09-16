/**
 * Connectivity validation against real sockets: the loopback mock proxies behave like the four
 * protocols we support, and the checker must classify every outcome (fast, slow, broken, refused)
 * with bounded time and retries. No live internet is required.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLogger,
  type ProxyEndpoint,
  type ProxyRequester,
  type ProxyResponse,
} from '@proxypulse/shared';
import { NodeProxyRequester } from '../worker/src/net/proxy-client';
import { ValidationChecker, type ValidationConfig } from '../worker/src/validation/checker';
import { startMockProxy, startMockTarget, type StartedProcess } from './helpers/servers';

const logger = createLogger({ name: 'validation-test', level: 'error' });

let target: StartedProcess;
let forward: StartedProcess;
let authed: StartedProcess;
let broken: StartedProcess;
let hanging: StartedProcess;
let slow: StartedProcess;

beforeAll(async () => {
  [target, forward, authed, broken, hanging, slow] = await Promise.all([
    startMockTarget(),
    startMockProxy('http'),
    startMockProxy('http', { requireAuth: 'alice:pw123' }),
    startMockProxy('http', { mode: 'reject' }),
    startMockProxy('http', { mode: 'hang' }),
    startMockProxy('http', { mode: 'slow', delayMs: 900 }),
  ]);
});

afterAll(async () => {
  await Promise.all(
    [target, forward, authed, broken, hanging, slow].map((proc) =>
      proc?.stop().catch(() => undefined),
    ),
  );
});

const baseConfig: ValidationConfig = {
  concurrency: 2,
  timeoutMs: 1_500,
  retries: 1,
  backoffBaseMs: 20,
  maxResponseBytes: 64 * 1024,
  checkUrl: '',
  successStatuses: [204, 200],
  requireEgressEcho: false,
  rejectLocalEgress: false,
};

const requesterFor = (allowPrivate = true): NodeProxyRequester =>
  new NodeProxyRequester({
    connectTimeoutMs: 1_000,
    timeoutMs: 1_500,
    maxResponseBytes: 64 * 1024,
    allowPrivateEndpoints: allowPrivate,
    dnsCacheTtlMs: 0,
  });

const checkerFor = (
  overrides: Partial<ValidationConfig> = {},
  allowPrivate = true,
): ValidationChecker =>
  new ValidationChecker({
    requester: requesterFor(allowPrivate),
    logger,
    config: {
      ...baseConfig,
      checkUrl: `http://127.0.0.1:${target.port}/generate_204`,
      ...overrides,
    },
  });

const endpoint = (port: number, extra: Partial<ProxyEndpoint> = {}): ProxyEndpoint => ({
  host: '127.0.0.1',
  port,
  protocol: 'http',
  ...extra,
});

describe('connectivity validation', () => {
  it('passes a forwarding proxy and records latency, status and transport', async () => {
    const checker = checkerFor();
    const outcome = await checker.validate(endpoint(forward.port), {
      cycle_id: 'cyc_t',
      proxy_id: 1,
    });
    expect(outcome.reachable).toBe(true);
    expect(outcome.http_status).toBe(204);
    expect(outcome.error_code).toBeNull();
    expect(outcome.latency_ms).not.toBeNull();
    expect(outcome.latency_ms!).toBeLessThan(1_500);
    expect(outcome.attempts).toBe(1);
    expect(outcome.transport).toContain('absolute-form');
    // no echo endpoint was configured, so the egress address is simply unknown here
    expect(outcome.egress).toBe('unknown');
  });

  it('authenticates when the proxy requires it', async () => {
    const checker = checkerFor();
    const ok = await checker.validate(
      endpoint(authed.port, { username: 'alice', password: 'pw123' }),
      { cycle_id: 'cyc_t' },
    );
    expect(ok.reachable).toBe(true);
    const denied = await checker.validate(endpoint(authed.port), { cycle_id: 'cyc_t' });
    expect(denied.reachable).toBe(false);
    expect(denied.http_status).toBe(407);
    expect(denied.error_code).toBe('proxy_auth_failed');
    expect(JSON.stringify(denied)).not.toContain('pw123');
  });

  it('classifies a refusing proxy without retrying it', async () => {
    const checker = checkerFor();
    const outcome = await checker.validate(endpoint(broken.port), { cycle_id: 'cyc_t' });
    expect(outcome.reachable).toBe(false);
    expect(outcome.error_code).toBe('unexpected_status');
    expect(outcome.attempts).toBe(1);
  });

  it('gives up on a hanging proxy within the timeout budget', async () => {
    const checker = checkerFor({ timeoutMs: 600, retries: 1 });
    const started = Date.now();
    const outcome = await checker.validate(endpoint(hanging.port), { cycle_id: 'cyc_t' });
    const elapsed = Date.now() - started;
    expect(outcome.reachable).toBe(false);
    expect(outcome.error_code).toBe('timeout');
    // `retries` is the total number of attempts: the wait is bounded by attempts * timeout
    expect(elapsed).toBeLessThan(3_000);
    expect(outcome.attempts).toBe(1);
  });

  it('retries transient failures and reports the attempt count', async () => {
    const checker = checkerFor({ retries: 3, timeoutMs: 400 });
    const outcome = await checker.validate(endpoint(hanging.port), { cycle_id: 'cyc_t' });
    expect(outcome.attempts).toBe(3);
    expect(outcome.reachable).toBe(false);
  });

  it('does not retry a dead port', async () => {
    const checker = checkerFor({ retries: 3 });
    const outcome = await checker.validate(endpoint(1), { cycle_id: 'cyc_t' });
    expect(outcome.error_code).toBe('connect_refused');
    expect(outcome.attempts).toBe(1);
  });

  it('treats a slow proxy as reachable when it answers in time', async () => {
    const checker = checkerFor({ timeoutMs: 3_000 });
    const outcome = await checker.validate(endpoint(slow.port), { cycle_id: 'cyc_t' });
    expect(outcome.reachable).toBe(true);
    expect(outcome.latency_ms! + 50).toBeGreaterThanOrEqual(900);
  });

  it('fails a proxy whose check endpoint answers with an unexpected status', async () => {
    const checker = new ValidationChecker({
      requester: requesterFor(),
      logger,
      config: {
        ...baseConfig,
        checkUrl: `http://127.0.0.1:${target.port}/status/418`,
        successStatuses: [204],
      },
    });
    const outcome = await checker.validate(endpoint(forward.port), { cycle_id: 'cyc_t' });
    expect(outcome.reachable).toBe(false);
    expect(outcome.http_status).toBe(418);
    expect(outcome.error_code).toBe('unexpected_status');
  });

  it('never throws when the requester itself explodes', async () => {
    const checker = new ValidationChecker({
      requester: {
        async request(): Promise<ProxyResponse> {
          throw new Error('socket vanished');
        },
      } satisfies ProxyRequester,
      logger,
      config: { ...baseConfig, checkUrl: `http://127.0.0.1:${target.port}/generate_204` },
    });
    const outcome = await checker.validate(endpoint(forward.port), { cycle_id: 'cyc_t' });
    expect(outcome.reachable).toBe(false);
    expect(outcome.error_code).toBe('unknown');
    expect(outcome.error_message ?? '').toContain('socket vanished');
    expect(JSON.stringify(outcome)).not.toContain('at 0x');
  });
});

describe('egress echo policy', () => {
  it('notes the observed egress address and can reject loopback exits', async () => {
    const echoUrl = `http://127.0.0.1:${target.port}/echo`;
    const lenient = new ValidationChecker({
      requester: requesterFor(),
      logger,
      config: {
        ...baseConfig,
        checkUrl: echoUrl,
        successStatuses: [200],
        requireEgressEcho: true,
        rejectLocalEgress: false,
      },
    });
    const noted = await lenient.validate(endpoint(forward.port), { cycle_id: 'cyc_t' });
    expect(noted.reachable).toBe(true);
    expect(noted.egress).toBe('local');

    const strict = new ValidationChecker({
      requester: requesterFor(),
      logger,
      config: {
        ...baseConfig,
        checkUrl: echoUrl,
        successStatuses: [200],
        requireEgressEcho: true,
        rejectLocalEgress: true,
      },
    });
    const rejected = await strict.validate(endpoint(forward.port), { cycle_id: 'cyc_t' });
    expect(rejected.reachable).toBe(false);
    expect(rejected.error_code).toBe('egress_local');
  });

  it('requires an echo when the check endpoint does not provide one', async () => {
    const checker = new ValidationChecker({
      requester: requesterFor(),
      logger,
      config: {
        ...baseConfig,
        checkUrl: `http://127.0.0.1:${target.port}/generate_204`,
        requireEgressEcho: true,
        rejectLocalEgress: false,
      },
    });
    const outcome = await checker.validate(endpoint(forward.port), { cycle_id: 'cyc_t' });
    expect(outcome.reachable).toBe(false);
    expect(outcome.error_code).toBe('no_egress_echo');
  });
});

describe('bounded concurrency', () => {
  it('never runs more probes than configured and keeps results aligned', async () => {
    let inFlight = 0;
    let peak = 0;
    const requester: ProxyRequester = {
      async request(): Promise<ProxyResponse> {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        return {
          ok: true,
          status: 204,
          headers: {},
          bodyBytes: 0,
          bodyText: '',
          truncated: false,
          latencyMs: 12,
          transport: 'absolute-form',
        } satisfies ProxyResponse;
      },
    };
    const checker = new ValidationChecker({
      requester,
      logger,
      config: { ...baseConfig, concurrency: 3, checkUrl: 'http://example.invalid/generate_204' },
    });
    const batch = Array.from({ length: 11 }, (_, index) => ({
      endpoint: { host: '127.0.0.1', port: 8080 + index, protocol: 'http' } as ProxyEndpoint,
      proxy_id: index + 1,
    }));
    const outcomes = await checker.validateMany(batch, { cycle_id: 'cyc_t' });
    expect(outcomes).toHaveLength(11);
    expect(peak).toBeLessThanOrEqual(3);
    expect(outcomes.every((outcome) => outcome.proxy.port >= 8080)).toBe(true);
    expect(outcomes.every((outcome) => outcome.reachable)).toBe(true);
  });
});
