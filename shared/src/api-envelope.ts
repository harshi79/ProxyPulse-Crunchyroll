/**
 * The public API contract: endpoints, response envelope and the JSON builders both the Cloudflare
 * gateway and the worker's internal API use. Keeping it here means the two can never drift.
 */

import {
  type ApiErrorCode,
  type ApiMeta,
  HTTP_STATUS_FOR_ERROR,
  type ApiFailure,
} from './types.js';

export const API_ENDPOINTS = ['/pool', '/random', '/stats', '/tpool', '/health'] as const;
export type ApiEndpoint = (typeof API_ENDPOINTS)[number];

/** Cache TTL (seconds) the gateway applies per endpoint. 0 disables caching. */
export const DEFAULT_CACHE_TTL_SECONDS: Record<ApiEndpoint, number> = {
  '/pool': 30,
  '/random': 0,
  '/stats': 15,
  '/tpool': 20,
  '/health': 0,
};

/** Requests allowed per client per window when no per-plan limits are configured. */
export const DEFAULT_RATE_LIMIT = { windowSeconds: 60, maxRequests: 120 } as const;

export const RESPONSE_HEADER_PREFIX = 'x-proxypulse';

export interface Envelope<T> {
  ok: true;
  data: T;
  meta: ApiMeta;
}

export function buildMeta(input: {
  request_id: string;
  service: string;
  pool_size?: number | null;
  last_update?: string | null;
  cached?: boolean;
  stale?: boolean;
  timestamp?: string;
}): ApiMeta {
  return {
    request_id: input.request_id,
    timestamp: input.timestamp ?? new Date().toISOString(),
    pool_size: input.pool_size ?? null,
    last_update: input.last_update ?? null,
    service: input.service,
    ...(input.cached === undefined ? {} : { cached: input.cached }),
    ...(input.stale === undefined ? {} : { stale: input.stale }),
  };
}

export function envelope<T>(data: T, meta: ApiMeta): Envelope<T> {
  return { ok: true, data, meta };
}

export const jsonHeaders: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
};

export function successResponse<T>(
  data: T,
  meta: ApiMeta,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(envelope(data, meta)), {
    status: init.status ?? 200,
    headers: { ...jsonHeaders, ...(init.headers ?? {}) },
  });
}

export function failureBody(code: ApiErrorCode, message: string, request_id: string): ApiFailure {
  return {
    ok: false,
    error: { code, message },
    meta: { request_id, timestamp: new Date().toISOString() },
  };
}

export function errorResponse(
  code: ApiErrorCode,
  message: string,
  request_id: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(failureBody(code, message, request_id)), {
    status: HTTP_STATUS_FOR_ERROR[code],
    headers: { ...jsonHeaders, ...headers },
  });
}

/** Truncates free text coming from upstream so error responses can never carry a large blob. */
export function safePublicMessage(input: string, max = 200): string {
  const cleaned = input
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}
