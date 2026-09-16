/**
 * Direct (non-proxied) HTTP GET with the same SSRF guarantees as the proxy client: the destination
 * is policy-checked, DNS is resolved and pinned through the safe lookup, responses are byte-capped
 * and every phase has a deadline. Used for proxy source downloads and robots.txt lookups.
 */

import net from 'node:net';
import tls from 'node:tls';

import { checkUrlPolicy } from '@proxypulse/shared';

import { buildHttpRequest, readHttpResponseFromSocket } from './http-response.js';
import { createSafeLookup } from './safe-lookup.js';

export interface DirectFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
  allowPrivate: boolean;
  maxRedirects?: number;
  dnsCacheTtlMs?: number;
}

export interface DirectFetchResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  text: string;
  bytes: number;
  truncated: boolean;
  latencyMs: number;
  finalUrl: string;
  error?: { code: string; message: string };
}

export class DirectFetcher {
  private readonly lookup: ReturnType<typeof createSafeLookup>;

  constructor(private readonly options: DirectFetchOptions) {
    this.lookup = createSafeLookup({
      allowPrivate: options.allowPrivate,
      cacheTtlMs: options.dnsCacheTtlMs ?? 60_000,
    });
  }

  async get(rawUrl: string): Promise<DirectFetchResult> {
    const started = Date.now();
    const deadline = started + this.options.timeoutMs;
    const maxRedirects = this.options.maxRedirects ?? 3;
    let current = rawUrl;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const verdict = checkUrlPolicy(current, { allowPrivate: this.options.allowPrivate });
      if (!verdict.ok) {
        return {
          ok: false,
          status: 0,
          headers: {},
          text: '',
          bytes: 0,
          truncated: false,
          latencyMs: Date.now() - started,
          finalUrl: current,
          error: { code: 'blocked_by_policy', message: verdict.reason },
        };
      }
      const url = verdict.url;
      const useTls = url.protocol === 'https:';
      const port = url.port.length > 0 ? Number(url.port) : useTls ? 443 : 80;

      let socket: net.Socket | tls.TLSSocket;
      try {
        socket = await this.#connect(url.hostname, port, useTls, deadline);
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        return {
          ok: false,
          status: 0,
          headers: {},
          text: '',
          bytes: 0,
          truncated: false,
          latencyMs: Date.now() - started,
          finalUrl: current,
          error: {
            code: nodeError.code ?? 'network_error',
            message: nodeError.message ?? String(error),
          },
        };
      }

      try {
        const path = `${url.pathname.length > 0 ? url.pathname : '/'}${url.search}`;
        socket.write(
          Buffer.from(
            buildHttpRequest('GET', path, url.host, {
              'user-agent': 'ProxyPulseBot/1.0',
              ...this.options.headers,
            }),
            'latin1',
          ),
        );
        const response = await readHttpResponseFromSocket(socket, {
          timeoutMs: Math.max(1, deadline - Date.now()),
          maxBytes: this.options.maxBytes,
        });
        const status = response.status;
        if (status >= 300 && status < 400 && response.headers.location) {
          if (hop === maxRedirects) {
            return {
              ok: false,
              status,
              headers: response.headers,
              text: '',
              bytes: 0,
              truncated: false,
              latencyMs: Date.now() - started,
              finalUrl: current,
              error: { code: 'too_many_redirects', message: 'redirect limit reached' },
            };
          }
          current = new URL(response.headers.location.split(',')[0]!.trim(), current).toString();
          socket.destroy();
          continue;
        }
        socket.destroy();
        return {
          ok: status >= 200 && status < 400,
          status,
          headers: response.headers,
          text: response.body.toString('utf8'),
          bytes: response.body.length,
          truncated: response.truncated,
          latencyMs: Date.now() - started,
          finalUrl: current,
        };
      } catch (error) {
        socket.destroy();
        const nodeError = error as Error & { code?: string };
        return {
          ok: false,
          status: 0,
          headers: {},
          text: '',
          bytes: 0,
          truncated: false,
          latencyMs: Date.now() - started,
          finalUrl: current,
          error: {
            code: nodeError.code ?? 'protocol_error',
            message: nodeError.message.slice(0, 200),
          },
        };
      }
    }
    throw new Error('unreachable');
  }

  #connect(
    host: string,
    port: number,
    useTls: boolean,
    deadline: number,
  ): Promise<net.Socket | tls.TLSSocket> {
    const timeout = Math.max(250, deadline - Date.now());
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const succeed = (value: net.Socket | tls.TLSSocket): void => {
        if (settled) return;
        settled = true;
        value.setTimeout(0);
        resolve(value);
      };

      const socket: net.Socket | tls.TLSSocket = useTls
        ? tls.connect({
            host: host.replace(/^\[|\]$/g, ''),
            port,
            lookup: this.lookup,
            servername: net.isIP(host) === 0 ? host : undefined,
            // A source list or robots.txt over a broken certificate is a fetch failure, not a
            // reason to silently downgrade to plaintext.
            rejectUnauthorized: true,
            timeout,
          })
        : net.connect({ host: host.replace(/^\[|\]$/g, ''), port, lookup: this.lookup, timeout });

      socket.once('error', fail);
      socket.once('timeout', () =>
        fail(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' })),
      );
      if (useTls) socket.once('secureConnect', () => succeed(socket));
      else (socket as net.Socket).once('connect', () => succeed(socket));
      setTimeout(() => fail(new Error('connect timed out')), timeout + 250).unref?.();
    });
  }
}
