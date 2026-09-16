/**
 * The only place in the gateway that talks to the worker. Requests carry the internal token; responses
 * are small JSON documents (the pool endpoints are paged and capped upstream), so bodies are read as
 * text with a hard ceiling before anything is parsed.
 */

import { API_ERROR_CODES, type ApiErrorCode } from '@proxypulse/shared';

import type { GatewayConfig } from './env';

/** 4 MB is far above any legitimate page of the pool and blocks a runaway origin. */
export const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;

export type UpstreamResult =
  | { ok: true; status: number; body: string; contentType: string }
  | { ok: false; status: number; code: ApiErrorCode; message: string };

export interface UpstreamOptions {
  path: string;
  search: string;
  config: GatewayConfig;
  requestId: string;
}

export async function callUpstream({
  path,
  search,
  config,
  requestId,
}: UpstreamOptions): Promise<UpstreamResult> {
  const url = `${config.renderOrigin}${path}${search.length > 0 ? `?${search}` : ''}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${config.internalToken}`,
        accept: 'application/json',
        'x-request-id': requestId,
        'x-proxypulse-gateway': 'cloudflare-worker',
      },
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      cf: { cacheTtl: 0, cacheEverything: false },
    } as RequestInit);
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return {
        ok: false,
        status: 504,
        code: 'timeout',
        message: 'the pool origin did not respond in time',
      };
    }
    return {
      ok: false,
      status: 503,
      code: 'unavailable',
      message: 'the pool origin is unreachable',
    };
  }

  if (!response.ok) {
    // The worker answers with our own error envelope, so a structured error is passed through with its
    // status and code intact (that is how `503 pool empty` survives the hop). Anything else is a
    // transport-level failure and gets a generic, non-echoing message.
    const text = await safeText(response);
    const forwarded = forwardEnvelopeError(text, response.status);
    if (forwarded) return forwarded;
    if (response.status >= 500) {
      return {
        ok: false,
        status: 502,
        code: 'upstream_error',
        message: 'the pool origin returned an error',
      };
    }
    return {
      ok: false,
      status: response.status,
      code: 'bad_request',
      message: summarize(text, response.status),
    };
  }

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_UPSTREAM_BYTES) {
    return {
      ok: false,
      status: 502,
      code: 'upstream_error',
      message: 'upstream response exceeded the size limit',
    };
  }
  const body = await safeText(response);
  if (body.length > MAX_UPSTREAM_BYTES) {
    return {
      ok: false,
      status: 502,
      code: 'upstream_error',
      message: 'upstream response exceeded the size limit',
    };
  }
  return {
    ok: true,
    status: response.status,
    body,
    contentType: response.headers.get('content-type') ?? 'application/json',
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Recognises the worker's failure envelope; returns null for anything that is not one. */
function forwardEnvelopeError(
  body: string,
  status: number,
): { ok: false; status: number; code: ApiErrorCode; message: string } | null {
  if (body.length === 0 || body.length > 64 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  const record = (parsed ?? {}) as { ok?: boolean; error?: { code?: unknown; message?: unknown } };
  if (record.ok !== false || typeof record.error !== 'object' || record.error === null) return null;
  const code =
    typeof record.error.code === 'string' &&
    (API_ERROR_CODES as readonly string[]).includes(record.error.code)
      ? (record.error.code as ApiErrorCode)
      : 'upstream_error';
  const message =
    typeof record.error.message === 'string'
      ? record.error.message.slice(0, 200)
      : 'the pool origin rejected the request';
  return { ok: false, status, code, message };
}

/** Never echo an upstream body verbatim: it may contain a stack trace. */
function summarize(body: string, status: number): string {
  const firstLine = body.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (firstLine.length === 0) return `upstream responded with ${status}`;
  return `upstream responded with ${status}`.concat(
    firstLine.includes('{') ? '' : `: ${firstLine}`,
  );
}
