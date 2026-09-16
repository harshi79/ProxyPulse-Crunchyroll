/**
 * SSRF and network-policy guarantees. The worker dials *attacker supplied* proxy addresses and fetches
 * attacker influenced URLs, so both sides are fenced: literal private/loopback/link-local/metadata
 * ranges are refused before a socket is opened, hostnames are re-checked after DNS, and dev escape
 * hatches never re-open the cloud metadata endpoints.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkUrlPolicy,
  inspectAddress,
  isMetadataHostname,
  isProxyEndpointAllowed,
} from '@proxypulse/shared';
import {
  clearAddressCache,
  createSafeLookup,
  safeResolve,
  SsrfBlockedError,
} from '../worker/src/net/safe-lookup';
import { NodeProxyRequester } from '../worker/src/net/proxy-client';

const ALWAYS_BLOCKED = [
  '127.0.0.1',
  '127.5.5.5',
  '10.0.0.7',
  '172.16.4.4',
  '192.168.1.254',
  '169.254.169.254',
  '0.0.0.0',
  '::1',
  'fe80::1',
  'fd00::12',
];

describe('address classification', () => {
  it.each(ALWAYS_BLOCKED)('flags %s as non-public', (host) => {
    expect(inspectAddress(host).blocked).toBe(true);
    expect(isProxyEndpointAllowed(host).ok).toBe(false);
  });

  it('accepts public addresses and hostnames', () => {
    expect(isProxyEndpointAllowed('8.8.8.8').ok).toBe(true);
    expect(isProxyEndpointAllowed('proxy.example.com').ok).toBe(true);
  });

  it('normalises bracketed IPv6 and decimal octets', () => {
    expect(isProxyEndpointAllowed('[::1]').ok).toBe(false);
    expect(isProxyEndpointAllowed('010.0.0.1').ok).toBe(false);
  });
});

describe('dev escape hatch', () => {
  it('permits private space but never the metadata endpoints', () => {
    expect(isProxyEndpointAllowed('127.0.0.1', { allowPrivate: true }).ok).toBe(true);
    expect(isProxyEndpointAllowed('192.168.0.10', { allowPrivate: true }).ok).toBe(true);
    expect(isProxyEndpointAllowed('169.254.169.254', { allowPrivate: true }).ok).toBe(false);
    expect(isProxyEndpointAllowed('[fd00::1]', { allowPrivate: true }).ok).toBe(true);
  });

  it('recognises the metadata hostnames of every major cloud', () => {
    for (const host of ['169.254.169.254', 'metadata.google.internal', 'metadata.goog']) {
      expect(isMetadataHostname(host), host).toBe(true);
    }
    expect(isMetadataHostname('meta.example.com')).toBe(false);
  });
});

describe('url policy', () => {
  const check = (url: string, policy = {}) => checkUrlPolicy(url, policy);

  it('rejects non-http(s) schemes outright', () => {
    for (const url of [
      'file:///etc/passwd',
      'gopher://127.0.0.1:70/x',
      'ftp://example.com',
      'data:text/plain,hi',
      'javascript:alert(1)',
    ]) {
      const verdict = check(url);
      expect(verdict.ok, url).toBe(false);
    }
  });

  it('rejects relative, oversized and control-character URLs', () => {
    expect(check('/robots.txt').ok).toBe(false);
    expect(check(`https://example.com/${'a'.repeat(3_000)}`).ok).toBe(false);
    expect(check('https://example.com/\r\nX-Evil: 1').ok).toBe(false);
    expect(check('   ').ok).toBe(false);
  });

  it('rejects credentials embedded in the URL (they would be forwarded verbatim)', () => {
    expect(check('http://admin:secret@example.com/').ok).toBe(false);
  });

  it('blocks loopback, link-local and metadata targets', () => {
    for (const url of [
      'http://127.0.0.1/generate_204',
      'http://localhost:8080/x',
      'http://[::1]/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/x',
      'http://10.20.30.40/x',
    ]) {
      const verdict = check(url);
      expect(verdict.ok, url).toBe(false);
    }
  });

  it('keeps the metadata block when private ranges are allowed for tests', () => {
    expect(check('http://127.0.0.1/x', { allowPrivate: true }).ok).toBe(true);
    expect(check('http://169.254.169.254/latest/meta-data', { allowPrivate: true }).ok).toBe(false);
  });

  it('refuses port 25 and non-allow-listed ports', () => {
    expect(check('http://example.com:25/').ok).toBe(false);
    expect(check('http://example.com:8443/x', { allowedPorts: [443, 8443] }).ok).toBe(true);
    expect(check('http://example.com:9999/x', { allowedPorts: [443] }).ok).toBe(false);
  });

  it('only accepts https when the policy says so (case insensitive scheme)', () => {
    expect(check('HTTPS://Example.COM/robots.txt', { allowedProtocols: ['https:'] }).ok).toBe(true);
    expect(check('http://example.com/robots.txt', { allowedProtocols: ['https:'] }).ok).toBe(false);
  });
});

describe('dns rebinding protection', () => {
  const resolver = (address: string) => ({
    resolve4: async () => [address],
    resolve6: async () => [],
  });

  beforeEach(() => clearAddressCache());
  afterEach(() => clearAddressCache());

  it('refuses a hostname that resolves into a private range', async () => {
    await expect(
      safeResolve('evil.example.com', { allowPrivate: false, resolver: resolver('127.0.0.1') }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(
      safeResolve('evil.example.com', {
        allowPrivate: false,
        resolver: resolver('169.254.169.254'),
      }),
    ).rejects.toThrow(/metadata/);
  });

  it('accepts a hostname that resolves to a public address', async () => {
    await expect(
      safeResolve('good.example.com', { allowPrivate: false, resolver: resolver('93.184.216.34') }),
    ).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('permits private results only when explicitly allowed, and caches them', async () => {
    let calls = 0;
    const counting = {
      resolve4: async () => {
        calls += 1;
        return ['10.1.2.3'];
      },
      resolve6: async () => [],
    };
    const first = await safeResolve('internal.example', {
      allowPrivate: true,
      resolver: counting,
      cacheTtlMs: 5_000,
    });
    const second = await safeResolve('internal.example', {
      allowPrivate: true,
      resolver: counting,
      cacheTtlMs: 5_000,
    });
    expect(first.address).toBe('10.1.2.3');
    expect(second.address).toBe('10.1.2.3');
    expect(calls).toBe(1);
  });

  it('exposes the same guard as a net.lookup function for sockets', async () => {
    const lookup = createSafeLookup({ allowPrivate: false, resolver: resolver('192.168.5.6') });
    await expect(
      new Promise((resolveLookup, rejectLookup) => {
        lookup('blocked.example.com', {}, (error, address, family) => {
          if (error) rejectLookup(error);
          else resolveLookup([address, family]);
        });
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe('the proxy client refuses to be pointed at the local network', () => {
  const requester = new NodeProxyRequester({
    connectTimeoutMs: 500,
    timeoutMs: 1_000,
    maxResponseBytes: 4_096,
    allowPrivateEndpoints: false,
    dnsCacheTtlMs: 0,
  });
  // TEST-NET addresses would be refused as "reserved"; this is a routable-looking public literal that
  // simply never answers in the sandbox, which is exactly what the allow-list check needs.
  const publicProxy = { host: '93.184.216.34', port: 8080, protocol: 'http' as const };

  it('blocks private proxy endpoints before dialling', async () => {
    const response = await requester.request(
      { host: '127.0.0.1', port: 8080, protocol: 'http' },
      'http://example.com/generate_204',
      { includeBody: false },
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('blocked_by_policy');
  });

  it.each([
    ['loopback target', 'http://127.0.0.1:9/generate_204'],
    ['link-local metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['private target', 'http://192.168.0.1/admin'],
  ])('blocks a %s even when the proxy itself is public', async (_label, url) => {
    const response = await requester.request(publicProxy, url, { includeBody: false });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('blocked_by_policy');
  });

  it('rejects non-http targets and credential-bearing URLs', async () => {
    await expect(requester.request(publicProxy, 'file:///etc/passwd')).resolves.toMatchObject({
      error: { code: 'blocked_by_policy' },
    });
    const smuggled = await requester.request(publicProxy, 'http://admin:pw@example.com/x', {
      includeBody: false,
    });
    expect(smuggled.error?.code).toBe('blocked_by_policy');
  });

  it('enforces a host allow-list when one is configured', async () => {
    const restricted = new NodeProxyRequester({
      connectTimeoutMs: 500,
      timeoutMs: 1_000,
      maxResponseBytes: 4_096,
      allowPrivateEndpoints: false,
      dnsCacheTtlMs: 0,
      allowedTargetHosts: ['www.crunchyroll.com'],
    });
    const offList = await restricted.request(publicProxy, 'http://example.com/robots.txt', {
      includeBody: false,
    });
    expect(offList.error?.code).toBe('blocked_by_policy');
    // an allow-listed host still fails at the transport (the proxy is a TEST-NET address) but not at the policy
    const onList = await restricted.request(publicProxy, 'https://www.crunchyroll.com/robots.txt', {
      includeBody: false,
    });
    expect(onList.error?.code).not.toBe('blocked_by_policy');
  });
});
