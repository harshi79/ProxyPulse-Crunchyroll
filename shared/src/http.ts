/**
 * HTTP contracts shared between the validation engine, the service adapters and the discovery
 * providers. The actual socket work lives in the worker (Node.js); the interfaces live here so
 * every component can be tested against the same types.
 */

import { type ProxyEndpoint } from './types.js';

export interface ProxyRequestOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** When false the body is drained but not returned (saves memory on big payloads). */
  includeBody?: boolean;
  signal?: AbortSignal;
}

export interface ProxyResponse {
  /** HTTP status received, or false when the transport itself failed. */
  ok: boolean;
  status: number | 0;
  statusText?: string;
  headers: Record<string, string>;
  bodyBytes: number;
  bodyText: string;
  truncated: boolean;
  latencyMs: number;
  /** Transport level failure detail (connect refused, TLS error, proxy protocol error...). */
  error?: { code: string; message: string };
  /** How the request was issued, for logs: 'connect-tunnel' | 'absolute-form' | 'socks-tunnel'. */
  transport?: string;
}

export interface ProxyRequestResult {
  response: ProxyResponse;
  /** Proxy endpoint the request went through (host/port/protocol only, never credentials). */
  endpoint: string;
}

/** Implemented by the worker's proxy client; consumed by validation and service adapters. */
export interface ProxyRequester {
  request(
    endpoint: ProxyEndpoint,
    url: string,
    options?: ProxyRequestOptions,
  ): Promise<ProxyResponse>;
}

export const TRANSPORT_ERROR_CODES = [
  'timeout',
  'connect_refused',
  'connect_reset',
  'dns_error',
  'proxy_unreachable',
  'proxy_auth_failed',
  'proxy_bad_gateway',
  'protocol_error',
  'tls_error',
  'blocked_by_policy',
  'too_many_redirects',
  'response_too_large',
  'aborted',
  'unknown',
] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

export interface FetchTextOptions {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface FetchTextResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  text: string;
  truncated: boolean;
  bytes: number;
  latencyMs: number;
  error?: { code: TransportErrorCode | string; message: string };
}

/**
 * Bounded `fetch` used for source downloads and robots.txt lookups. Works in Node.js and
 * Cloudflare Workers (global fetch), always enforces a byte cap and a deadline.
 */
export async function fetchTextLimited(
  url: string,
  options: FetchTextOptions = {},
): Promise<FetchTextResult> {
  const started = Date.now();
  const maxBytes = options.maxBytes ?? 1_000_000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else
      options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), {
        once: true,
      });
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/plain,application/json;q=0.9,*/*;q=0.5',
        'user-agent': 'ProxyPulseBot/1.0 (+https://github.com/harshi79/ProxyPulse-Crunchyroll)',
        ...(options.headers ?? {}),
      },
    });

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    let text = '';
    let bytes = 0;
    let truncated = false;
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const chunks: string[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      text = chunks.join('');
    } else {
      const buffer = await response.text();
      bytes = buffer.length;
      text = buffer.slice(0, maxBytes);
      truncated = bytes > maxBytes;
    }

    return {
      ok: response.ok,
      status: response.status,
      headers,
      text,
      truncated,
      bytes,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      status: 0,
      headers: {},
      text: '',
      truncated: false,
      bytes: 0,
      latencyMs: Date.now() - started,
      error: {
        code: aborted ? 'timeout' : 'network_error',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
