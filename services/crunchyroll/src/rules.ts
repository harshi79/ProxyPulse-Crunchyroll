/**
 * Response rules: how a proxied probe response maps onto a service verdict.
 *
 * The rules are intentionally conservative: anything that looks like bot blocking, a challenge
 * page or rate limiting is recorded as `blocked` (and down-weights the proxy) instead of being
 * treated as something to work around.
 */

import { type ProxyResponse } from '@proxypulse/shared';

import { type CrunchyrollVerdict } from './types.js';

export interface RuleOutcome {
  verdict: CrunchyrollVerdict;
  /** null for a clean pass. */
  reason: string | null;
  /** Rate-limit backoff requested by the service, when present. */
  retryAfterMs: number | null;
  details: Record<string, string | number | boolean>;
}

/** Markers that indicate an interstitial/challenge page rather than the requested content. */
const BLOCK_MARKERS = [
  'just a moment',
  'cf-browser-verification',
  'cf_chl_opt',
  'attention required',
  'pardon our interruption',
  'access denied',
  'request blocked',
  'enable javascript and cookies',
  'captcha',
  'akamai edge',
  'reference #',
] as const;

const ROBOTS_MARKERS = ['user-agent', 'disallow', 'sitemap', 'allow'] as const;

export const SUCCESS_STATUS_MIN = 200;
export const SUCCESS_STATUS_MAX = 399;

/** Statuses that mean "you are being throttled/blocked" rather than "this proxy is broken". */
const RATE_LIMIT_STATUSES = new Set([429, 503]);
const DENY_STATUSES = new Set([401, 403, 406, 407, 451]);

export function parseRetryAfterMs(
  value: string | undefined,
  now: number = Date.now(),
): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - now);
}

export function containsBlockMarker(bodyText: string): string | null {
  const haystack = bodyText.slice(0, 8_000).toLowerCase();
  for (const marker of BLOCK_MARKERS) if (haystack.includes(marker)) return marker;
  return null;
}

/** Sanity check so a captive portal / interception page cannot count as success. */
export function bodyLooksExpected(bodyText: string, checkPath: string, status: number): boolean {
  if (status === 204 || bodyText.length === 0) return true; // some endpoints answer with no body
  if (checkPath.endsWith('robots.txt')) {
    const lower = bodyText.slice(0, 4_000).toLowerCase();
    const hits = ROBOTS_MARKERS.filter((marker) => lower.includes(marker));
    return hits.length >= 1;
  }
  return bodyText.trim().length > 0;
}

export interface EvaluateInput {
  response: ProxyResponse;
  checkPath: string;
  /** Whether robots.txt permitted the probe for our user agent. */
  robotsAllowed: boolean;
  robotsReason: string;
  expectedHost: string;
}

export function evaluateProbedResponse(input: EvaluateInput): RuleOutcome {
  const { response, checkPath, robotsAllowed, robotsReason } = input;
  const details: Record<string, string | number | boolean> = {
    transport: response.transport ?? 'unknown',
    body_bytes: response.bodyBytes,
    truncated: response.truncated,
  };

  if (!robotsAllowed) {
    return {
      verdict: 'skipped',
      reason: `robots_disallowed:${robotsReason}`,
      retryAfterMs: null,
      details,
    };
  }

  if (response.error) {
    const code = response.error.code;
    // The proxy itself is unusable for real traffic; distinguish "proxy broken" from "service refused".
    if (
      code === 'proxy_auth_failed' ||
      code === 'proxy_bad_gateway' ||
      code === 'connect_refused'
    ) {
      return { verdict: 'failed', reason: `proxy_error:${code}`, retryAfterMs: null, details };
    }
    if (code === 'blocked_by_policy') {
      return { verdict: 'skipped', reason: 'blocked_by_policy', retryAfterMs: null, details };
    }
    return { verdict: 'failed', reason: `transport_error:${code}`, retryAfterMs: null, details };
  }

  const status = response.status;
  details.http_status = status;
  const retryAfterMs = parseRetryAfterMs(response.headers['retry-after']);
  const marker = containsBlockMarker(response.bodyText);
  if (marker) details.block_marker = marker;
  if (response.headers['cf-mitigated']) details.cf_mitigated = true;

  if (RATE_LIMIT_STATUSES.has(status)) {
    return { verdict: 'blocked', reason: `rate_limited:${status}`, retryAfterMs, details };
  }
  if (DENY_STATUSES.has(status)) {
    return { verdict: 'blocked', reason: `denied:${status}`, retryAfterMs, details };
  }
  if (status >= 500) {
    return {
      verdict: 'failed',
      reason: `service_error:${status}`,
      retryAfterMs: retryAfterMs ?? 5_000,
      details,
    };
  }
  if (status < SUCCESS_STATUS_MIN || status > SUCCESS_STATUS_MAX) {
    return { verdict: 'failed', reason: `unexpected_status:${status}`, retryAfterMs, details };
  }
  if (marker || response.headers['cf-mitigated']) {
    return { verdict: 'blocked', reason: 'bot_challenge', retryAfterMs, details };
  }
  if (!bodyLooksExpected(response.bodyText, checkPath, status)) {
    return { verdict: 'failed', reason: 'unexpected_content', retryAfterMs, details };
  }
  return { verdict: 'passed', reason: null, retryAfterMs: null, details };
}

/**
 * Request headers for the probe. Deliberately a normal, non-spoofed browser-ish identity: we are
 * measuring reachability, not trying to look like something we are not.
 */
export function probeHeaders(userAgent: string): Record<string, string> {
  return {
    'user-agent': userAgent,
    accept: 'text/plain,*/*;q=0.8',
    'accept-language': 'en',
    'cache-control': 'no-cache',
  };
}
