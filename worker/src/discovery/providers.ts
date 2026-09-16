/**
 * Discovery providers (the adapter layer).
 *
 * A provider turns "somewhere proxies are published" into raw entry strings. Everything after that
 * (normalization, dedupe, validation) is shared. Adding a source = adding a config entry, never
 * editing the pipeline.
 *
 * Providers must only point at sources that permit automated collection. No scraping around
 * rate limits, no logins, no bypassing anything.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  detectProtocolFromLabel,
  LOG_EVENTS,
  parseProxyList,
  type AnonymityLevel,
  type Logger,
  type NormalizedProxy,
  type ProxyProtocol,
} from '@proxypulse/shared';

import type { DirectFetchResult } from '../net/direct-fetch.js';
import type { RobotsGate } from './robots-gate.js';
import type { SourceConfig } from '../config.js';

export interface DiscoveryContext {
  cycleId: string;
  logger: Logger;
  signal?: AbortSignal;
  /** Policy-checked direct download (SSRF guards, byte cap, deadline). */
  fetchText: (url: string) => Promise<DirectFetchResult>;
  cwd: string;
  /** robots.txt gate for remote sources (absent = no gate, e.g. tests). */
  robots?: RobotsGate;
}

export interface ProviderResult {
  proxies: NormalizedProxy[];
  rejected: { line: string; reason: string }[];
  duplicates: number;
  fetched_lines: number;
  bytes: number;
  status: number;
  note: string | null;
}

export interface DiscoveryProvider {
  readonly id: string;
  readonly kind: SourceConfig['kind'];
  readonly trust: number;
  fetch(context: DiscoveryContext): Promise<ProviderResult>;
}

const MAX_JSON_ITEMS = 50_000;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const pick = (source: Record<string, unknown>, keys: readonly string[] | undefined): unknown => {
  for (const key of keys ?? []) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

const pickString = (
  source: Record<string, unknown>,
  keys: readonly string[] | undefined,
): string | null => {
  const value = pick(source, keys);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
};

/** Walks a dot path like `data.proxies` through unknown JSON. */
export function itemsAtPath(payload: unknown, path: string | undefined): unknown[] {
  let cursor: unknown = payload;
  for (const segment of (path ?? '').split('.').filter(Boolean)) {
    const record = asRecord(cursor);
    if (!record) return [];
    cursor = record[segment];
  }
  return Array.isArray(cursor) ? cursor.slice(0, MAX_JSON_ITEMS) : [];
}

/** Per-item metadata that the flattened `host:port` representation would otherwise lose. */
interface JsonItemMeta {
  protocol?: ProxyProtocol;
  country?: string;
  anonymity?: AnonymityLevel;
  username?: string;
  password?: string;
}

const ANONYMITY_MAP: Record<string, AnonymityLevel> = {
  elite: 'elite',
  high匿名: 'elite',
  high: 'elite',
  anonymous: 'anonymous',
  transparent: 'transparent',
  unknown: 'unknown',
};

export abstract class BaseProvider implements DiscoveryProvider {
  abstract readonly kind: SourceConfig['kind'];

  constructor(
    readonly config: SourceConfig,
    readonly logger: Logger,
  ) {}

  get id(): string {
    return this.config.id;
  }

  /**
   * Politeness before any remote fetch: consult the origin's robots.txt for our user agent, refuse the
   * source when it says no (or when the file cannot be read — fail closed, the same rule the service
   * adapter applies), then honour its `Crawl-delay`.
   */
  protected async politeness(context: DiscoveryContext): Promise<string | null> {
    const url = this.config.url;
    if (!url) return null;
    if (this.config.respectRobots === false) {
      this.logger.warn('source is configured to skip the robots.txt check', {
        event: LOG_EVENTS.DISCOVERY_SOURCE_ROBOTS,
        source: this.id,
      });
      return 'robots.txt check disabled by source config';
    }
    const gate = context.robots;
    if (!gate) return null;
    const verdict = await gate.check(url);
    if (!verdict.allowed) {
      throw new Error(`source ${this.id} not fetched: robots.txt (${verdict.reason})`);
    }
    await gate.waitForTurn(url);
    return verdict.minIntervalMs > 0 ? `robots.txt crawl delay ${verdict.minIntervalMs}ms` : null;
  }

  get trust(): number {
    return Math.max(0, Math.min(1, this.config.trust ?? 0.5));
  }

  protected finish(
    text: string,
    note: string | null,
    bytes: number,
    status: number,
  ): ProviderResult {
    const parsed = parseProxyList(text, {
      protocolHint: this.config.protocol,
      maxEntries: this.config.maxEntries,
    });
    return {
      proxies: parsed.proxies,
      rejected: parsed.rejected,
      duplicates: parsed.duplicates,
      fetched_lines: parsed.total_lines,
      bytes,
      status,
      note,
    };
  }

  /** Note text for the per-source outcome, combining the transport and robots observations. */
  protected combineNotes(truncated: boolean, robots: string | null): string | null {
    if (truncated && robots) return `response truncated at byte cap; ${robots}`;
    if (truncated) return 'response truncated at byte cap';
    return robots;
  }

  abstract fetch(context: DiscoveryContext): Promise<ProviderResult>;
}

/** Plain text list, one entry per line (`host:port`, `proto://host:port`, ...). */
export class HttpListProvider extends BaseProvider {
  readonly kind = 'http-list' as const;

  override async fetch(context: DiscoveryContext): Promise<ProviderResult> {
    if (!this.config.url) throw new Error(`source ${this.id} has no url`);
    const robots = await this.politeness(context);
    const result = await context.fetchText(this.config.url);
    if (!result.ok) {
      throw new Error(
        `source ${this.id} returned status ${result.status || 'n/a'}${result.error ? `: ${result.error.message}` : ''}`,
      );
    }
    return this.finish(
      result.text,
      this.combineNotes(result.truncated, robots),
      result.bytes,
      result.status,
    );
  }
}

/** JSON API returning an array of objects (or strings). */
export class JsonEndpointProvider extends BaseProvider {
  readonly kind = 'json-endpoint' as const;

  override async fetch(context: DiscoveryContext): Promise<ProviderResult> {
    if (!this.config.url) throw new Error(`source ${this.id} has no url`);
    const robots = await this.politeness(context);
    const result = await context.fetchText(this.config.url);
    if (!result.ok) {
      throw new Error(
        `source ${this.id} returned status ${result.status || 'n/a'}${result.error ? `: ${result.error.message}` : ''}`,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.text);
    } catch {
      throw new Error(`source ${this.id} did not return valid JSON`);
    }

    const fields = this.config.fields ?? {};
    const endpointKeys = fields.endpoint ?? [
      'proxy',
      'endpoint',
      'server',
      'address',
      'host_port',
      'anonymity',
    ];
    const hostKeys = fields.host ?? ['host', 'ip', 'ip_address', 'address'];
    const portKeys = fields.port ?? ['port'];
    const protocolKeys = fields.protocol ?? ['protocol', 'scheme', 'type'];
    const countryKeys = fields.country ?? ['country', 'country_code', 'geo', 'location_code'];
    const anonymityKeys = fields.anonymity ?? ['anonymity', 'anon', 'level'];
    const userKeys = fields.username ?? ['username', 'user', 'login'];
    const passKeys = fields.password ?? ['password', 'pass'];

    const lines: string[] = [];
    const metaByEndpoint = new Map<string, JsonItemMeta>();
    let index = 0;

    for (const item of itemsAtPath(payload, this.config.itemsPath)) {
      index += 1;
      if (typeof item === 'string') {
        lines.push(item);
        continue;
      }
      const record = asRecord(item);
      if (!record) continue;
      const raw = pickString(record, endpointKeys);
      let host: string | null;
      let port: string | null;
      let endpointLine: string;

      if (raw) {
        endpointLine = raw.trim();
        const authority = endpointLine.includes('://')
          ? endpointLine.slice(endpointLine.indexOf('://') + 3)
          : endpointLine;
        const withoutAuth = authority.includes('@')
          ? authority.slice(authority.lastIndexOf('@') + 1)
          : authority;
        const parts = withoutAuth.split(':');
        host = parts[0] ?? null;
        port = parts[1]?.split('/')[0] ?? null;
      } else {
        host = pickString(record, hostKeys);
        port = pickString(record, portKeys);
        if (!host || !port) continue;
        endpointLine = `${host.trim()}:${port.trim()}`;
      }
      if (!host || !port) continue;

      lines.push(endpointLine);
      const meta: JsonItemMeta = {};
      const protocolLabel = pickString(record, protocolKeys);
      const detected = protocolLabel ? detectProtocolFromLabel(protocolLabel) : null;
      if (detected) meta.protocol = detected;
      const country = pickString(record, countryKeys);
      if (country && /^[a-z]{2}$/i.test(country.trim()))
        meta.country = country.trim().toUpperCase();
      const anonymity = pickString(record, anonymityKeys);
      if (anonymity) {
        const mapped = ANONYMITY_MAP[anonymity.trim().toLowerCase()];
        if (mapped) meta.anonymity = mapped;
      }
      const username = pickString(record, userKeys);
      const password = pickString(record, passKeys);
      if (username) meta.username = username;
      if (password) meta.password = password;
      if (Object.keys(meta).length > 0) {
        metaByEndpoint.set(`${host.trim()}:${port.trim()}`.toLowerCase(), meta);
      }
    }

    const parsed = parseProxyList(lines.join('\n'), {
      protocolHint: this.config.protocol,
      maxEntries: this.config.maxEntries,
    });

    // Re-attach per-item metadata that a flat `host:port` line cannot carry.
    const enriched = parsed.proxies.map((proxy) => {
      const meta = metaByEndpoint.get(`${proxy.host}:${proxy.port}`.toLowerCase());
      if (!meta) return proxy;
      const withMeta: NormalizedProxy = { ...proxy };
      if (proxy.protocol === 'http' && meta.protocol) withMeta.protocol = meta.protocol;
      if (meta.country) withMeta.country = meta.country;
      if (meta.anonymity) withMeta.anonymity = meta.anonymity;
      if (meta.username && !withMeta.username) {
        withMeta.username = meta.username;
        if (meta.password) withMeta.password = meta.password;
      }
      return withMeta;
    });

    return {
      proxies: enriched,
      rejected: parsed.rejected,
      duplicates: parsed.duplicates,
      fetched_lines: index,
      bytes: result.bytes,
      status: result.status,
      note: this.combineNotes(result.truncated, robots),
    };
  }
}

/**
 * A local file of proxy entries. Used for offline development, the test fixtures and operators who
 * keep a private seed list. Paths are confined to the repository working directory.
 */
export class LocalFileProvider extends BaseProvider {
  readonly kind = 'local-file' as const;

  override async fetch(context: DiscoveryContext): Promise<ProviderResult> {
    const relative = this.config.path;
    if (!relative) throw new Error(`source ${this.id} has no path`);
    const absolute = resolve(context.cwd, relative);
    if (!absolute.startsWith(resolve(context.cwd) + '/') && absolute !== resolve(context.cwd)) {
      throw new Error(`source ${this.id} resolves outside the working directory`);
    }
    let text: string;
    try {
      text = await readFile(absolute, 'utf8');
    } catch (error) {
      throw new Error(
        `source ${this.id} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return this.finish(text, null, Buffer.byteLength(text, 'utf8'), 200);
  }
}

export function createProviders(
  configs: readonly SourceConfig[],
  logger: Logger,
): DiscoveryProvider[] {
  return configs
    .filter((config) => config.enabled)
    .map((config) => {
      switch (config.kind) {
        case 'http-list':
          return new HttpListProvider(config, logger);
        case 'json-endpoint':
          return new JsonEndpointProvider(config, logger);
        case 'local-file':
          return new LocalFileProvider(config, logger);
        default:
          throw new Error(`unknown source kind "${config.kind}" for source ${config.id}`);
      }
    });
}
