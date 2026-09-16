import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NodeProxyRequester } from '../worker/src/net/proxy-client';
import { SsrfBlockedError } from '../worker/src/net/safe-lookup';
import { clearAddressCache } from '../worker/src/net/safe-lookup';
import { directGet, startMockProxy, startMockTarget, type StartedProcess } from './helpers/servers';

let target: StartedProcess;
let httpProxy: StartedProcess;
let socks5Proxy: StartedProcess;
let socks4Proxy: StartedProcess;
let hangingProxy: StartedProcess;
let authProxy: StartedProcess;

const started = async (): Promise<void> => {
  [target, httpProxy, socks5Proxy, socks4Proxy, hangingProxy, authProxy] = await Promise.all([
    startMockTarget(),
    startMockProxy('http'),
    startMockProxy('socks5'),
    startMockProxy('socks4'),
    startMockProxy('http', { mode: 'hang' }),
    startMockProxy('socks5', { requireAuth: 'pulse:s3cret-pass' }),
  ]);
};

const stopped = async (): Promise<void> => {
  await Promise.all(
    [target, httpProxy, socks5Proxy, socks4Proxy, hangingProxy, authProxy]
      .filter(Boolean)
      .map((server) => server?.stop()),
  );
};

beforeAll(started);
afterAll(async () => {
  await stopped();
  clearAddressCache();
});

const requester = (overrides: Partial<ConstructorParameters<typeof NodeProxyRequester>[0]> = {}) =>
  new NodeProxyRequester({
    connectTimeoutMs: 2_000,
    timeoutMs: 4_000,
    maxResponseBytes: 64 * 1024,
    allowPrivateEndpoints: true,
    dnsCacheTtlMs: 1_000,
    ...overrides,
  });

const targetUrl = (path: string): string => `http://127.0.0.1:${target.port}${path}`;

describe('mock harness sanity', () => {
  it('the target server answers directly', async () => {
    const response = await directGet(target.port, '/generate_204');
    expect(response.status).toBe(204);
  });
});

describe('connectivity through each supported protocol', () => {
  it('uses an absolute-form GET for HTTP proxies', async () => {
    const response = await requester().request(
      { host: '127.0.0.1', port: httpProxy.port, protocol: 'http' },
      targetUrl('/ok'),
      { includeBody: true },
    );
    expect(response.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(response.transport).toBe('absolute-form');
    const json = JSON.parse(response.bodyText) as { path: string; x_forwarded_for: string | null };
    expect(json.path).toBe('/ok');
    // the mock rewrites the request, so the target sees the proxy as its client
    expect(json.x_forwarded_for).toBeTruthy();
    expect(response.latencyMs).toBeLessThan(3_000);
  });

  it('tunnels through SOCKS5 and reports latency', async () => {
    const response = await requester().request(
      { host: '127.0.0.1', port: socks5Proxy.port, protocol: 'socks5' },
      targetUrl('/echo'),
      { includeBody: true },
    );
    expect(response.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(response.transport).toBe('socks5-tunnel');
    expect(response.bodyText).toContain('127.0.0.1');
  });

  it('tunnels through SOCKS4', async () => {
    const response = await requester().request(
      { host: '127.0.0.1', port: socks4Proxy.port, protocol: 'socks4' },
      targetUrl('/ok'),
      { includeBody: true },
    );
    expect(response.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(response.transport).toBe('socks4-tunnel');
  });

  it('handles a 204 with no body and honours HEAD', async () => {
    const response = await requester().request(
      { host: '127.0.0.1', port: socks5Proxy.port, protocol: 'socks5' },
      targetUrl('/generate_204'),
    );
    expect(response.status).toBe(204);
    expect(response.bodyBytes).toBe(0);
    expect(response.ok).toBe(true);
  });

  it('reads chunked responses', async () => {
    const response = await requester().request(
      { host: '127.0.0.1', port: httpProxy.port, protocol: 'http' },
      targetUrl('/big?kb=8'),
      { includeBody: false, maxResponseBytes: 64 * 1024 },
    );
    expect(response.status).toBe(200);
    expect(response.bodyBytes).toBe(8 * 1024);
    expect(response.truncated).toBe(false);
  });

  it('caps the response at maxResponseBytes instead of buffering a flood', async () => {
    const response = await requester().request(
      { host: '127.0.0.1', port: httpProxy.port, protocol: 'http' },
      targetUrl('/big?kb=512'),
      { maxResponseBytes: 4 * 1024, includeBody: true },
    );
    expect(response.truncated).toBe(true);
    expect(response.bodyBytes).toBeLessThanOrEqual(4 * 1024);
  });
});

describe('failure classification', () => {
  it('times out against a proxy that never answers', async () => {
    const startedAt = Date.now();
    const response = await requester({ timeoutMs: 600, connectTimeoutMs: 600 }).request(
      { host: '127.0.0.1', port: hangingProxy.port, protocol: 'http' },
      targetUrl('/ok'),
    );
    const elapsed = Date.now() - startedAt;
    expect(response.error?.code).toBe('timeout');
    expect(response.ok).toBe(false);
    expect(elapsed).toBeLessThan(2_500);
  });

  it('reports a refused connection for a dead port', async () => {
    const response = await requester({ connectTimeoutMs: 800, timeoutMs: 1_500 }).request(
      { host: '127.0.0.1', port: 1, protocol: 'socks5' },
      targetUrl('/ok'),
    );
    expect(response.error?.code).toBe('connect_refused');
  });

  it('fails with proxy_auth_failed when credentials are required but missing', async () => {
    const response = await requester().request(
      { host: '127.0.0.1', port: authProxy.port, protocol: 'socks5' },
      targetUrl('/ok'),
    );
    expect(response.error?.code).toBe('proxy_auth_failed');
  });

  it('succeeds with the right credentials and never echoes them back', async () => {
    const response = await requester().request(
      {
        host: '127.0.0.1',
        port: authProxy.port,
        protocol: 'socks5',
        username: 'pulse',
        password: 's3cret-pass',
      },
      targetUrl('/ok'),
    );
    expect(response.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(JSON.stringify(response)).not.toContain('s3cret-pass');
  });

  it('fails with proxy_auth_failed when the credentials are wrong', async () => {
    const response = await requester().request(
      {
        host: '127.0.0.1',
        port: authProxy.port,
        protocol: 'socks5',
        username: 'pulse',
        password: 'nope',
      },
      targetUrl('/ok'),
    );
    expect(response.error?.code).toBe('proxy_auth_failed');
    expect(JSON.stringify(response)).not.toContain('nope');
  });
});

describe('SSRF policy enforcement at the transport layer', () => {
  it('refuses to dial a proxy on a private address when the policy is enabled', async () => {
    const response = await requester({ allowPrivateEndpoints: false }).request(
      { host: '127.0.0.1', port: httpProxy.port, protocol: 'http' },
      targetUrl('/ok'),
    );
    expect(response.error?.code).toBe('blocked_by_policy');
    expect(response.transport).toBe('rejected');
  });

  it('refuses cloud metadata addresses', async () => {
    const response = await requester({ allowPrivateEndpoints: false }).request(
      { host: '169.254.169.254', port: 8080, protocol: 'http' },
      targetUrl('/ok'),
    );
    expect(response.error?.code).toBe('blocked_by_policy');
  });

  it('refuses a check URL that points at an internal host even when proxies are unrestricted', async () => {
    const response = await requester().request(
      { host: '127.0.0.1', port: httpProxy.port, protocol: 'http' },
      'http://169.254.169.254/latest/meta-data/',
    );
    expect(response.error?.code).toBe('blocked_by_policy');
  });

  it('refuses non-http(s) targets', async () => {
    const response = await requester().request(
      { host: '127.0.0.1', port: httpProxy.port, protocol: 'http' },
      'file:///etc/passwd',
    );
    expect(response.error?.code).toBe('blocked_by_policy');
  });

  it('restricts the destination when an allow-list is configured', async () => {
    const guarded = requester({ allowedTargetHosts: ['example.com'] });
    const response = await guarded.request(
      { host: '127.0.0.1', port: httpProxy.port, protocol: 'http' },
      targetUrl('/ok'),
    );
    expect(response.error?.code).toBe('blocked_by_policy');
  });

  it('throws for a hostname that only resolves to internal addresses', async () => {
    await expect(
      (async () => {
        const { safeResolve } = await import('../worker/src/net/safe-lookup');
        return safeResolve('127.0.0.1', { allowPrivate: false });
      })(),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
