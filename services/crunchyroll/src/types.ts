/**
 * Types and configuration for the Crunchyroll compatibility adapter.
 *
 * Scope: this adapter answers one question — "can this proxy complete a normal, unauthenticated
 * HTTPS request against an endpoint we are allowed to fetch?" It deliberately does NOT try to
 * bypass geo-restrictions, bot protection, CAPTCHAs, rate limits or authentication, and it never
 * touches login endpoints or DRM endpoints.
 */

import { type ProxyRequester, type ServiceStatus } from '@proxypulse/shared';

export const SERVICE_NAME = 'crunchyroll' as const;
export type ServiceName = typeof SERVICE_NAME;

/** Endpoints this adapter may ever be pointed at. Anything else is refused. */
export const ALLOWED_CRUNCHYROLL_HOSTS = [
  'www.crunchyroll.com',
  'static.crunchyroll.com',
  'crunchyroll.com',
] as const;

export interface CrunchyrollCheckConfig {
  service: ServiceName;
  /** Master switch. When false the pipeline records `skipped` and the pool uses connectivity only. */
  enabled: boolean;
  /**
   * Path fetched through each proxy. Defaults to `/robots.txt`: tiny, unauthenticated, allowed for
   * every user agent, and enough to prove the proxy can complete a real TLS request.
   */
  checkPath: string;
  scheme: 'https' | 'http';
  /** Optional full override of the probe URL (must resolve to an allowed host). */
  checkUrl?: string | undefined;
  allowedHosts: readonly string[];
  userAgent: string;
  timeoutMs: number;
  /** Requests per minute towards the target service, across all proxies in this process. */
  rateLimitPerMinute: number;
  /** Hard cap on how many proxies get a service check in one cycle. */
  maxChecksPerCycle: number;
  /** Minimum spacing between two requests to the service (seconds). */
  minRequestSpacingMs: number;
  respectRobots: boolean;
  robotsCacheTtlMs: number;
  /** Score threshold under which a proxy is not worth spending a service check on. */
  minScoreForServiceCheck: number;
}

export const DEFAULT_CRUNCHYROLL_CONFIG: CrunchyrollCheckConfig = {
  service: SERVICE_NAME,
  enabled: true,
  checkPath: '/robots.txt',
  scheme: 'https',
  allowedHosts: ALLOWED_CRUNCHYROLL_HOSTS,
  userAgent: 'ProxyPulseBot/1.0 (+https://github.com/harshi79/ProxyPulse-Crunchyroll)',
  timeoutMs: 8_000,
  rateLimitPerMinute: 30,
  maxChecksPerCycle: 250,
  minRequestSpacingMs: 250,
  respectRobots: true,
  robotsCacheTtlMs: 6 * 60 * 60 * 1000,
  minScoreForServiceCheck: 10,
};

/** Direct (non-proxied) fetch used for robots.txt only. Implemented by the worker. */
export interface DirectFetcher {
  (
    url: string,
    init: { headers: Record<string, string>; timeoutMs: number },
  ): Promise<{
    status: number;
    text: string;
    error?: string | undefined;
  }>;
}

export type CrunchyrollVerdict = 'passed' | 'failed' | 'blocked' | 'skipped';

export interface CrunchyrollCheckResult {
  service: ServiceName;
  proxy_id?: number;
  cycle_id?: string;
  passed: boolean;
  status: ServiceStatus;
  verdict: CrunchyrollVerdict;
  http_status: number | null;
  latency_ms: number | null;
  /** Machine readable reason, safe to store and to expose in aggregate. */
  reason: string | null;
  /** Small allow-listed summary. Never headers, never proxy credentials. */
  details: Record<string, string | number | boolean>;
  /** When the service asked us to slow down. */
  retry_after_ms: number | null;
  robots: { checked: boolean; allowed: boolean; reason: string; crawl_delay_ms: number | null };
}

export interface CheckerDeps {
  requester: ProxyRequester;
  direct: DirectFetcher;
  config: CrunchyrollCheckConfig;
  logger: {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  now?: () => number;
}

export interface CheckContext {
  proxy_id: number;
  cycle_id: string;
}
