/**
 * robots.txt enforcement for remote discovery sources.
 *
 * Fetching somebody else's list is a courtesy, not a right, so before an HTTP source is fetched we
 * check its `robots.txt` for our user agent and refuse the fetch when the path is disallowed or the
 * file cannot be read (fail closed, matching the service adapter). Decisions are cached per origin for
 * an hour, and a `Crawl-delay` widens the spacing between requests to that host.
 */

import { evaluateRobots, LOG_EVENTS, type Logger } from '@proxypulse/shared';

import type { DirectFetchResult } from '../net/direct-fetch.js';

export interface RobotsVerdict {
  allowed: boolean;
  reason: string;
  /** Minimum spacing to keep between requests to this origin, in ms. */
  minIntervalMs: number;
}

const ALLOWED: RobotsVerdict = { allowed: true, reason: 'not_applicable', minIntervalMs: 0 };

export interface RobotsGate {
  check(url: string): Promise<RobotsVerdict>;
  /** Wait until the origin's crawl delay has elapsed since the previous request. */
  waitForTurn(url: string): Promise<void>;
}

/** Just the fetch side of the worker's direct fetcher, so the gate is easy to test and reuse. */
export interface RobotsFetch {
  get(url: string): Promise<DirectFetchResult>;
}

export interface RobotsGateOptions {
  direct: RobotsFetch;
  userAgent: string;
  ttlMs?: number;
  logger: Logger;
  now?: () => number;
}

interface CacheEntry {
  verdict: RobotsVerdict;
  expires: number;
}

const originOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export function createRobotsGate(options: RobotsGateOptions): RobotsGate {
  const ttl = options.ttlMs ?? 60 * 60 * 1000;
  const cache = new Map<string, CacheEntry>();
  const lastHit = new Map<string, number>();
  const now = options.now ?? (() => Date.now());

  async function check(url: string): Promise<RobotsVerdict> {
    const origin = originOf(url);
    if (!origin) return { allowed: false, reason: 'invalid url', minIntervalMs: 0 };
    const hit = cache.get(origin);
    if (hit && hit.expires > now()) return hit.verdict;

    let robotsPath: string;
    try {
      robotsPath = new URL(url).pathname;
    } catch {
      return { allowed: false, reason: 'invalid url', minIntervalMs: 0 };
    }

    let verdict: RobotsVerdict;
    try {
      const robots = await options.direct.get(`${origin}/robots.txt`);
      if (!robots.ok && robots.status !== 404 && robots.status !== 410) {
        // cannot read it → do not fetch the site
        verdict = {
          allowed: false,
          reason: `robots.txt unreadable (${robots.error?.code ?? robots.status})`,
          minIntervalMs: 0,
        };
      } else {
        const decision = evaluateRobots(robotsPath, options.userAgent, {
          status: robots.status,
          text: robots.text,
        });
        verdict = {
          allowed: decision.allowed,
          reason: decision.reason,
          minIntervalMs:
            decision.crawlDelaySeconds === null
              ? 0
              : Math.max(0, Math.round(decision.crawlDelaySeconds * 1000)),
        };
      }
    } catch (error) {
      verdict = {
        allowed: false,
        reason: `robots.txt fetch failed: ${error instanceof Error ? error.message : 'unknown'}`,
        minIntervalMs: 0,
      };
    }

    cache.set(origin, { verdict, expires: now() + ttl });
    options.logger.info('robots policy evaluated', {
      event: LOG_EVENTS.DISCOVERY_SOURCE_ROBOTS,
      origin,
      allowed: verdict.allowed,
      reason: verdict.reason,
      crawl_delay_ms: verdict.minIntervalMs,
    });
    return verdict;
  }

  async function waitForTurn(url: string): Promise<void> {
    const origin = originOf(url);
    if (!origin) return;
    const verdict = cache.get(origin);
    const delay = verdict?.verdict.minIntervalMs ?? 0;
    if (delay <= 0) {
      lastHit.set(origin, now());
      return;
    }
    const previous = lastHit.get(origin);
    const wait = previous === undefined ? 0 : Math.max(0, delay - (now() - previous));
    lastHit.set(origin, now() + wait);
    if (wait > 0) await sleep(wait);
  }

  return { check, waitForTurn };
}

/** A gate that allows everything: used for `local-file` sources and when robots checking is disabled. */
export const permissiveRobotsGate: RobotsGate = {
  check: async () => ALLOWED,
  waitForTurn: async () => undefined,
};
