/**
 * Provider adapters and the discovery orchestrator: configurable sources, tolerant parsing with
 * explicit reject reasons, per-source tracking, bounded concurrency, bounded retries, hard entry
 * caps — and one misbehaving source never taking the cycle down.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger, dedupeKeyHash } from '@proxypulse/shared';
import type { DirectFetchResult } from '../worker/src/net/direct-fetch';
import { loadConfig, type SourceConfig } from '../worker/src/config';
import {
  createProviders,
  HttpListProvider,
  itemsAtPath,
  JsonEndpointProvider,
  LocalFileProvider,
  type DiscoveryContext,
  type ProviderResult,
} from '../worker/src/discovery/providers';
import { DiscoveryService } from '../worker/src/discovery/service';
import { createRobotsGate, type RobotsGate } from '../worker/src/discovery/robots-gate';

const logger = createLogger({ name: 'discovery-test', level: 'error' });
const FIXTURE_URL = new URL('./fixtures/proxies.sample.txt', import.meta.url);
const FIXTURE_TEXT = readFileSync(FIXTURE_URL, 'utf8');
const fixtureDir = mkdtempSync(join(tmpdir(), 'proxypulse-discovery-'));
const fixturePath = join(fixtureDir, 'sample.txt');
writeFileSync(fixturePath, FIXTURE_TEXT);

afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

const fetched = (text: string, overrides: Partial<DirectFetchResult> = {}): DirectFetchResult => ({
  ok: true,
  status: 200,
  headers: {},
  text,
  bytes: Buffer.byteLength(text),
  truncated: false,
  latencyMs: 5,
  finalUrl: 'https://source.invalid/list.txt',
  ...overrides,
});

const contextWith = (
  impl: (url: string) => Promise<DirectFetchResult>,
  cwd = '/',
): DiscoveryContext => ({
  cycleId: 'cyc_test',
  logger,
  cwd,
  fetchText: impl,
});

const source = (overrides: Partial<SourceConfig>): SourceConfig => ({
  id: 'unit-test',
  kind: 'http-list',
  enabled: true,
  url: 'https://source.invalid/list.txt',
  ...overrides,
});

describe('http-list provider', () => {
  it('normalises the sample list and reports rejects, duplicates and skipped noise', async () => {
    const provider = new HttpListProvider(source({}), logger);
    const result = await provider.fetch(contextWith(async () => fetched(FIXTURE_TEXT)));
    expect(result.proxies).toHaveLength(8);
    expect(result.rejected).toHaveLength(3);
    expect(result.duplicates).toBe(1);
    expect(result.fetched_lines).toBe(26);
    expect(result.proxies.map((proxy) => proxy.protocol)).toEqual([
      'http',
      'http',
      'http',
      'http',
      'socks5',
      'socks5',
      'socks4',
      'https',
    ]);
    expect(result.proxies[1]?.username).toBe('alice');
  });

  it('never reports credentials in the reject or note fields', async () => {
    const provider = new HttpListProvider(source({}), logger);
    const result = await provider.fetch(
      contextWith(async () => fetched('http://u:supersecret@203.0.113.9:8080\nbad-line-x\n')),
    );
    expect(result.proxies[0]?.password).toBe('supersecret');
    expect(JSON.stringify(result.rejected)).not.toContain('supersecret');
    expect(JSON.stringify(result)).toContain('supersecret'); // the credential lives on the candidate, not the report
  });

  it('applies maxEntries and flags a truncated source', async () => {
    const text = Array.from(
      { length: 500 },
      (_, index) => `203.0.113.${(index % 250) + 1}:${8000 + index}`,
    ).join('\n');
    const provider = new HttpListProvider(source({ maxEntries: 20 }), logger);
    const result = await provider.fetch(contextWith(async () => fetched(text)));
    expect(result.proxies).toHaveLength(20);
    const truncatedProvider = new HttpListProvider(source({}), logger);
    const truncated = await truncatedProvider.fetch(
      contextWith(async () => fetched(text, { truncated: true })),
    );
    expect(truncated.note).toContain('truncated');
  });

  it('turns an unsuccessful fetch into a thrown, source-labelled error', async () => {
    const provider = new HttpListProvider(source({}), logger);
    await expect(
      provider.fetch(contextWith(async () => fetched('', { ok: false, status: 403 }))),
    ).rejects.toThrow(/unit-test returned status 403/);
    await expect(
      provider.fetch(
        contextWith(async () =>
          fetched('', { ok: false, status: 0, error: { code: 'timeout', message: 'deadline' } }),
        ),
      ),
    ).rejects.toThrow(/deadline/);
  });
});

describe('json-endpoint provider', () => {
  const payload = JSON.stringify({
    meta: { count: 3 },
    data: {
      proxies: [
        {
          ip: '203.0.113.50',
          port: 8080,
          scheme: 'http',
          country: 'us',
          google: 'anonymous',
          speed: 120,
        },
        { ip: '203.0.113.51', port: 1080, scheme: 'socks5', country: 'DE' },
        { endpoint: '203.0.113.52:3128', anon: 'elite' },
      ],
    },
  });

  it('reads nested arrays via itemsPath and maps fields in priority order', async () => {
    const provider = new JsonEndpointProvider(
      source({
        kind: 'json-endpoint',
        itemsPath: 'data.proxies',
        fields: {
          host: ['ip', 'host'],
          port: ['port'],
          protocol: ['scheme'],
          country: ['country'],
          anonymity: ['google', 'anon'],
          endpoint: ['endpoint'],
        },
      }),
      logger,
    );
    const result = await provider.fetch(contextWith(async () => fetched(payload)));
    expect(
      result.proxies.map((proxy) => `${proxy.protocol}://${proxy.host}:${proxy.port}`),
    ).toEqual([
      'http://203.0.113.50:8080',
      'socks5://203.0.113.51:1080',
      'http://203.0.113.52:3128',
    ]);
    expect(result.proxies[0]?.country).toBe('US');
    expect(result.proxies[0]?.anonymity).toBe('anonymous');
    // per-item metadata stays attached to the right entry
    expect(result.proxies[2]?.anonymity).toBe('elite');
    expect(result.rejected).toHaveLength(0);
  });

  it('tolerates a bare array payload and unknown shapes', async () => {
    const provider = new JsonEndpointProvider(source({ kind: 'json-endpoint' }), logger);
    const bare = await provider.fetch(
      contextWith(async () => fetched('["203.0.113.60:80","203.0.113.61:1080"]')),
    );
    expect(bare.proxies.map((proxy) => proxy.port)).toEqual([80, 1080]);
    const junk = await provider.fetch(contextWith(async () => fetched('{"unexpected": true}')));
    expect(junk.proxies).toHaveLength(0);
  });

  it('walks dot paths safely', () => {
    const value = { a: { b: [{ c: 1 }] } };
    expect(itemsAtPath(value, 'a.b')).toEqual([{ c: 1 }]);
    expect(itemsAtPath(value, 'a.missing.b')).toEqual([]);
    expect(itemsAtPath(value, undefined)).toEqual([]);
    expect(itemsAtPath([{ x: 1 }], undefined)).toEqual([{ x: 1 }]);
  });
});

describe('local-file provider', () => {
  it('reads a repo-relative fixture file', async () => {
    const provider = new LocalFileProvider(
      source({ kind: 'local-file', url: undefined, path: 'sample.txt' }),
      logger,
    );
    const result = await provider.fetch(contextWith(async () => fetched(''), fixtureDir));
    expect(result.proxies.length).toBeGreaterThan(0);
    expect(result.status).toBe(200);
  });

  it('refuses to read outside the working directory and reports a missing file', async () => {
    const escape = new LocalFileProvider(
      source({ kind: 'local-file', url: undefined, path: '../../../etc/passwd' }),
      logger,
    );
    await expect(escape.fetch(contextWith(async () => fetched(''), fixtureDir))).rejects.toThrow(
      /outside the working directory/,
    );
    const missing = new LocalFileProvider(
      source({ kind: 'local-file', url: undefined, path: 'nope.txt' }),
      logger,
    );
    await expect(missing.fetch(contextWith(async () => fetched(''), fixtureDir))).rejects.toThrow(
      /could not be read/,
    );
  });
});

describe('provider factory', () => {
  it('instantiates only enabled sources and rejects unknown kinds', () => {
    const providers = createProviders(
      [
        source({ id: 'on', kind: 'http-list' }),
        { ...source({ id: 'off', kind: 'http-list' }), enabled: false },
      ],
      logger,
    );
    expect(providers.map((provider) => provider.id)).toEqual(['on']);
    expect(() =>
      createProviders(
        [{ ...source({ id: 'weird' }), kind: 'ftp-tunnel' as SourceConfig['kind'] }],
        logger,
      ),
    ).toThrow(/unknown source kind/);
  });

  it('defaults trust to the middle of the range', () => {
    const [provider] = createProviders([source({ id: 't' })], logger);
    expect(provider?.trust).toBe(0.5);
  });
});

/** Hand written providers: the orchestrator must not care where the text came from. */
const stubProvider = (id: string, impl: () => Promise<ProviderResult>, trust = 0.5) => ({
  id,
  kind: 'http-list' as const,
  trust,
  fetch: () => impl(),
});

const result = (
  proxies: ProviderResult['proxies'],
  extra: Partial<ProviderResult> = {},
): ProviderResult => ({
  proxies,
  rejected: [],
  duplicates: 0,
  fetched_lines: proxies.length,
  bytes: 10,
  status: 200,
  note: null,
  ...extra,
});

const proxy = (host: string, port = 8080) => ({
  host,
  port,
  protocol: 'http' as const,
  anonymity: 'unknown' as const,
});

const directResult = (overrides: Partial<DirectFetchResult>): DirectFetchResult => ({
  ok: true,
  status: 200,
  headers: {},
  text: '',
  bytes: 0,
  truncated: false,
  latencyMs: 3,
  finalUrl: '',
  ...overrides,
});

const gateFor = (
  robots: (url: string) => Partial<DirectFetchResult>,
  userAgent = 'ProxyPulseBot/1.0',
): RobotsGate =>
  createRobotsGate({
    direct: {
      async get(url) {
        return directResult({ finalUrl: url, ...robots(url) });
      },
    },
    userAgent,
    logger,
    ttlMs: 60_000,
  });

describe('robots gate (discovery politeness)', () => {
  it('refuses a path the source disallows for us', async () => {
    const gate = gateFor(() => ({ text: 'User-agent: ProxyPulseBot/1.0\nDisallow: /lists\n' }));
    const verdict = await gate.check('https://lists.example.net/lists/proxies.txt');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('disallow');
  });

  it('allows a path the source permits, and honours Crawl-delay', async () => {
    let calls = 0;
    const gate = createRobotsGate({
      direct: {
        async get() {
          calls += 1;
          return directResult({
            text: 'User-agent: *\nAllow: /lists/proxies.txt\nDisallow: /\nCrawl-delay: 0.05\n',
          });
        },
      },
      userAgent: 'ProxyPulseBot/1.0',
      logger,
    });
    const verdict = await gate.check('https://lists.example.net/lists/proxies.txt');
    expect(verdict.allowed).toBe(true);
    expect(verdict.minIntervalMs).toBe(50);
    const started = Date.now();
    await gate.waitForTurn('https://lists.example.net/lists/proxies.txt');
    await gate.waitForTurn('https://lists.example.net/lists/proxies.txt');
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    // the decision itself is cached per origin
    expect(calls).toBe(1);
  });

  it('treats a missing robots.txt as permission, and an unreadable one as a refusal', async () => {
    const missing = gateFor(() => ({ status: 404, ok: false, error: undefined as never }));
    expect(await missing.check('https://a.example/x.txt')).toMatchObject({ allowed: true });

    const broken = gateFor(() => ({
      ok: false,
      status: 0,
      error: { code: 'timeout', message: 'deadline' } as never,
    }));
    const verdict = await broken.check('https://b.example/x.txt');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('unreadable');
  });

  it('refuses to fetch a source whose robots.txt says no, without dialling it', async () => {
    let fetched = 0;
    const provider = new HttpListProvider(
      source({ id: 'gated', url: 'https://lists.example.net/lists/proxies.txt' }),
      logger,
    );
    const context: DiscoveryContext = {
      cycleId: 'cyc_gated',
      logger,
      cwd: '/',
      async fetchText() {
        fetched += 1;
        return directResult({ text: '203.0.113.5:8080\n' });
      },
      robots: gateFor((url) =>
        url.endsWith('/robots.txt') ? { text: 'User-agent: *\nDisallow: /lists\n' } : {},
      ),
    };
    await expect(provider.fetch(context)).rejects.toThrow(/not fetched: robots\.txt \(disallow\)/);
    expect(fetched).toBe(0);
  });

  it('lets a self-hosted source opt out, and records the exception in the note', async () => {
    let checked = 0;
    const provider = new HttpListProvider(
      source({ id: 'self-hosted', url: 'https://inventory.internal/list', respectRobots: false }),
      logger,
    );
    const context: DiscoveryContext = {
      cycleId: 'cyc_self',
      logger,
      cwd: '/',
      fetchText: async () => directResult({ text: '203.0.113.6:8080\n' }),
      robots: {
        async check() {
          checked += 1;
          return { allowed: false, reason: 'disallow', minIntervalMs: 0 };
        },
        async waitForTurn() {
          /* noop */
        },
      },
    };
    const result = await provider.fetch(context);
    expect(checked).toBe(0);
    expect(result.proxies).toHaveLength(1);
    expect(result.note).toContain('disabled');
  });

  it('does not retry a robots refusal inside the service loop', async () => {
    let calls = 0;
    const provider = {
      id: 'blocked',
      kind: 'http-list' as const,
      trust: 0.5,
      async fetch(): Promise<ProviderResult> {
        calls += 1;
        throw new Error('source blocked not fetched: robots.txt (disallow)');
      },
    };
    const service = new DiscoveryService({
      providers: [provider],
      concurrency: 1,
      retries: 4,
      backoffBaseMs: 1,
      candidateCap: 10,
      logger,
      context: { cycleId: 'cyc_robots', cwd: '/', fetchText: async () => directResult({}) },
    });
    const run = await service.run();
    expect(calls).toBe(1);
    expect(run.per_source[0]?.error).toContain('robots.txt');
  });
});

describe('discovery service', () => {
  it('merges, dedupes across sources and remembers who reported what', async () => {
    const a = stubProvider(
      'alpha',
      async () => result([proxy('203.0.113.1'), proxy('203.0.113.2')]),
      0.9,
    );
    const b = stubProvider(
      'beta',
      async () => result([proxy('203.0.113.2'), proxy('203.0.113.3')]),
      0.2,
    );
    const service = new DiscoveryService({
      providers: [a, b],
      concurrency: 2,
      retries: 1,
      backoffBaseMs: 1,
      candidateCap: 100,
      logger,
      context: { cycleId: 'cyc_x', cwd: '/', fetchText: async () => fetched('') },
    });
    const run = await service.run();
    expect(run.candidates.map((candidate) => candidate.host)).toEqual([
      '203.0.113.1',
      '203.0.113.2',
      '203.0.113.3',
    ]);
    expect(run.sourceByDedupeKey.get(dedupeKeyHash(proxy('203.0.113.2')))).toBe('alpha');
    expect(run.trustByDedupeKey.get(dedupeKeyHash(proxy('203.0.113.3')))).toBe(0.2);
    expect(run.totals).toMatchObject({
      discovered: 4,
      accepted: 3,
      duplicates: 1,
      sources_ok: 2,
      sources_failed: 0,
    });
    expect(run.per_source.map((outcome) => [outcome.source, outcome.status])).toEqual([
      ['alpha', 'ok'],
      ['beta', 'ok'],
    ]);
  });

  it('records a failure per source instead of throwing', async () => {
    const broken = stubProvider('broken', async () => {
      throw new Error('connection reset by peer');
    });
    const good = stubProvider('good', async () => result([proxy('203.0.113.9')]));
    const service = new DiscoveryService({
      providers: [broken, good],
      concurrency: 4,
      retries: 1,
      backoffBaseMs: 1,
      candidateCap: 10,
      logger,
      context: { cycleId: 'cyc_y', cwd: '/', fetchText: async () => fetched('') },
    });
    const run = await service.run();
    expect(run.candidates).toHaveLength(1);
    expect(run.totals.sources_failed).toBe(1);
    const failure = run.per_source.find((outcome) => outcome.source === 'broken');
    expect(failure?.status).toBe('failed');
    expect(failure?.error).toContain('connection reset');
    expect(failure?.attempts).toBe(1);
  });

  it('retries a flaky source up to the configured number of attempts', async () => {
    let calls = 0;
    const flaky = stubProvider('flaky', async () => {
      calls += 1;
      if (calls < 3) throw new Error('status 500 from origin');
      return result([proxy('203.0.113.30')]);
    });
    const service = new DiscoveryService({
      providers: [flaky],
      concurrency: 1,
      retries: 4,
      backoffBaseMs: 1,
      candidateCap: 10,
      logger,
      context: { cycleId: 'cyc_z', cwd: '/', fetchText: async () => fetched('') },
    });
    const run = await service.run();
    expect(calls).toBe(3);
    expect(run.per_source[0]?.attempts).toBe(3);
    expect(run.per_source[0]?.status).toBe('ok');
  });

  it('does not retry a client-side 4xx', async () => {
    let calls = 0;
    const denied = stubProvider('denied', async () => {
      calls += 1;
      throw new Error('source denied returned status 403');
    });
    const service = new DiscoveryService({
      providers: [denied],
      concurrency: 1,
      retries: 4,
      backoffBaseMs: 1,
      candidateCap: 10,
      logger,
      context: { cycleId: 'cyc_403', cwd: '/', fetchText: async () => fetched('') },
    });
    await service.run();
    expect(calls).toBe(1);
  });

  it('bounds concurrency and enforces the candidate cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = (id: string, count: number) =>
      stubProvider(id, async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return result(
          Array.from({ length: count }, (_, index) => proxy(`${id}.${index}`, 1000 + index)),
        );
      });
    const providers = ['s1', 's2', 's3', 's4', 's5'].map((id) => slow(id, 30));
    const service = new DiscoveryService({
      providers,
      concurrency: 2,
      retries: 1,
      backoffBaseMs: 1,
      candidateCap: 40,
      logger,
      context: { cycleId: 'cyc_cap', cwd: '/', fetchText: async () => fetched('') },
    });
    const run = await service.run();
    expect(peak).toBeLessThanOrEqual(2);
    expect(run.candidates).toHaveLength(40);
    expect(run.totals.discovered).toBe(150);
    expect(run.totals.accepted).toBe(40);
    expect(run.totals.duplicates).toBe(110);
  });

  it('survives an empty source set', async () => {
    const service = new DiscoveryService({
      providers: [],
      concurrency: 2,
      retries: 1,
      backoffBaseMs: 1,
      candidateCap: 10,
      logger,
      context: { cycleId: 'cyc_empty', cwd: '/', fetchText: async () => fetched('') },
    });
    const run = await service.run();
    expect(run.candidates).toEqual([]);
    expect(run.totals.sources_ok).toBe(0);
  });
});

describe('source configuration', () => {
  const base = { ENVIRONMENT: 'test', DATABASE_URL: 'file:x.db' };

  it('loads inline sources from PROXY_SOURCES_JSON', () => {
    const config = loadConfig({
      env: {
        ...base,
        PROXY_SOURCES_JSON: JSON.stringify([
          { id: 'seed', kind: 'local-file', path: 'tests/fixtures/proxies.sample.txt' },
        ]),
      },
    });
    expect(config.discovery.sources.map((entry) => entry.id)).toEqual(['seed']);
    expect(config.discovery.sources[0]?.enabled).toBe(true);
  });

  it('rejects bad ids, unknown kinds, duplicate ids and traversing paths', () => {
    const tryLoad = (sources: unknown) => () =>
      loadConfig({ env: { ...base, PROXY_SOURCES_JSON: JSON.stringify(sources) } });
    expect(tryLoad([{ id: 'Bad Id', kind: 'http-list', url: 'https://x' }])).toThrow(
      /id must match/,
    );
    expect(tryLoad([{ id: 'source-a', kind: 'scrape', url: 'https://x' }])).toThrow(/unknown kind/);
    expect(
      tryLoad([
        { id: 'source-a', kind: 'http-list', url: 'https://x' },
        { id: 'source-a', kind: 'http-list', url: 'https://y' },
      ]),
    ).toThrow(/duplicate source id/);
    expect(tryLoad([{ id: 'source-a', kind: 'local-file', path: '../../etc/passwd' }])).toThrow(
      /must not traverse/,
    );
    expect(tryLoad([{ id: 'source-a', kind: 'local-file' }])).toThrow(/requires a path/);
    expect(tryLoad([{ id: 'source-a', kind: 'http-list' }])).toThrow(/requires a url/);
    // ids shorter than two characters are rejected with the pattern spelled out
    expect(tryLoad([{ id: 'a', kind: 'http-list', url: 'https://x' }])).toThrow(/id must match/);
  });

  it('ships a default source file that never touches the network on its own', () => {
    const config = loadConfig({ env: base, cwd: process.cwd() });
    // whatever is in config/sources.json, no remote source may be enabled out of the box
    expect(config.discovery.sources.length).toBeGreaterThan(0);
    for (const entry of config.discovery.sources) {
      expect(entry.kind, entry.id).toBe('local-file');
      expect(entry.enabled, entry.id).toBe(false);
    }
  });
});
