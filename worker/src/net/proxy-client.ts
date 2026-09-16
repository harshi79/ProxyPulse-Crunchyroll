/**
 * The Node.js proxy client: how ProxyPulse actually dials a proxy and learns whether it forwards
 * traffic. Supports HTTP (absolute-form GET), HTTPS proxies (TLS to the proxy + CONNECT),
 * SOCKS5 (RFC1928/1929) and SOCKS4/4a, with:
 *
 *   - endpoint policy enforcement (no private/loopback/metadata proxies),
 *   - target policy enforcement (no internal check URLs, optional host allow-list),
 *   - a pinned, policy-checked DNS answer (defeats DNS rebinding),
 *   - hard timeouts on connect, handshake and response, and a response byte cap.
 */

import type { LookupFunction, Socket } from 'node:net';
import net from 'node:net';
import tls from 'node:tls';

import {
  checkUrlPolicy,
  formatProxyRedacted,
  inspectAddress,
  isProxyEndpointAllowed,
  type ProxyEndpoint,
  type ProxyRequester,
  type ProxyRequestOptions,
  type ProxyResponse,
  type TransportErrorCode,
} from '@proxypulse/shared';

import { buildHttpRequest, readHttpResponse, absoluteFormTarget } from './http-response.js';
import { ProxyHandshakeError, socks4Connect, socks5Connect } from './socks.js';
import { createSafeLookup, SsrfBlockedError } from './safe-lookup.js';
import { StreamBuffer } from './stream-buffer.js';

export interface NodeProxyRequesterOptions {
  connectTimeoutMs: number;
  timeoutMs: number;
  maxResponseBytes: number;
  allowPrivateEndpoints: boolean;
  dnsCacheTtlMs: number;
  /** When set, requests may only target these hosts (used for the service adapter). */
  allowedTargetHosts?: readonly string[];
  /**
   * Certificates of public HTTPS proxies are usually self-signed. We only use that TLS session to
   * build a tunnel — the *target* TLS handshake is always verified — so we do not reject here.
   */
  verifyProxyTls?: boolean;
}

interface Tunnel {
  socket: Socket;
  stream: StreamBuffer;
  transport: string;
}

const errorCode = (error: unknown): { code: TransportErrorCode; message: string } => {
  if (error instanceof SsrfBlockedError)
    return { code: 'blocked_by_policy', message: error.message };
  if (error instanceof ProxyHandshakeError) return { code: error.code, message: error.message };
  const node = error as NodeJS.ErrnoException;
  const code = node?.code;
  const message = node?.message ?? String(error);
  switch (code) {
    case 'ECONNREFUSED':
      return { code: 'connect_refused', message: 'connection refused' };
    case 'ECONNRESET':
    case 'EPIPE':
      return { code: 'connect_reset', message: 'connection reset' };
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return { code: 'timeout', message: 'connection timed out' };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAFNOSUPPORT':
      return { code: 'dns_error', message: 'address not resolvable' };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ENETDOWN':
      return { code: 'proxy_unreachable', message: 'network unreachable' };
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return { code: 'tls_error', message: 'TLS certificate rejected' };
    default:
      if (/timed?\s*out/i.test(message)) return { code: 'timeout', message: 'timed out' };
      if (/closed|mid-body|handshake/i.test(message))
        return { code: 'protocol_error', message: 'connection closed early' };
      if (/certificate|ssl|tls/i.test(message)) return { code: 'tls_error', message: 'TLS error' };
      return { code: 'unknown', message: message.slice(0, 200) };
  }
};

const failedResponse = (
  code: TransportErrorCode,
  message: string,
  started: number,
): ProxyResponse => ({
  ok: false,
  status: 0,
  headers: {},
  bodyBytes: 0,
  bodyText: '',
  truncated: false,
  latencyMs: Date.now() - started,
  error: { code, message },
});

export class NodeProxyRequester implements ProxyRequester {
  private readonly options: {
    connectTimeoutMs: number;
    timeoutMs: number;
    maxResponseBytes: number;
    allowPrivateEndpoints: boolean;
    dnsCacheTtlMs: number;
    verifyProxyTls: boolean;
    allowedTargetHosts?: readonly string[];
  };
  private readonly lookup: LookupFunction;

  constructor(options: NodeProxyRequesterOptions) {
    this.options = {
      connectTimeoutMs: options.connectTimeoutMs,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      allowPrivateEndpoints: options.allowPrivateEndpoints,
      dnsCacheTtlMs: options.dnsCacheTtlMs,
      verifyProxyTls: options.verifyProxyTls ?? false,
      allowedTargetHosts: options.allowedTargetHosts,
    };
    this.lookup = createSafeLookup({
      allowPrivate: this.options.allowPrivateEndpoints,
      cacheTtlMs: this.options.dnsCacheTtlMs,
    });
  }

  /** Endpoint policy: refuse proxies that point at internal addresses. */
  assertEndpointAllowed(endpoint: ProxyEndpoint): void {
    const check = isProxyEndpointAllowed(endpoint.host, {
      allowPrivate: this.options.allowPrivateEndpoints,
    });
    if (!check.ok) {
      throw new SsrfBlockedError(
        endpoint.host,
        `proxy endpoint rejected: ${check.reason}`,
        check.classification,
      );
    }
  }

  private assertTargetAllowed(url: URL): void {
    const hosts = this.options.allowedTargetHosts;
    if (!hosts || hosts.length === 0) return;
    const host = url.hostname.toLowerCase();
    if (!hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
      throw new SsrfBlockedError(host, 'target host is not in the allow-list', 'reserved');
    }
  }

  private connectBaseSocket(endpoint: ProxyEndpoint): Promise<Socket> {
    const timeout = this.options.connectTimeoutMs;
    return new Promise<Socket>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const succeed = (value: Socket): void => {
        if (settled) return;
        settled = true;
        value.setTimeout(0);
        resolve(value);
      };

      const common = { port: endpoint.port, lookup: this.lookup, keepAlive: false, noDelay: true };
      const socket: Socket | tls.TLSSocket =
        endpoint.protocol === 'https'
          ? tls.connect({
              ...common,
              host: endpoint.host,
              servername:
                inspectAddress(endpoint.host).kind === 'hostname' ? endpoint.host : undefined,
              // Tunnel transport only; the target certificate is validated separately.
              rejectUnauthorized: this.options.verifyProxyTls,
              timeout,
            })
          : net.connect({ ...common, host: endpoint.host, timeout });

      socket.once('error', fail);
      if (endpoint.protocol === 'https') {
        socket.once('secureConnect', () => succeed(socket as Socket));
      } else {
        socket.once('connect', () => succeed(socket));
      }
      socket.once('timeout', () => {
        const error = new Error('connect timed out') as NodeJS.ErrnoException;
        error.code = 'ETIMEDOUT';
        fail(error);
      });
      // Absolute safety net: never let a stuck connect outlive the budget.
      setTimeout(() => fail(new Error('connect timed out')), timeout + 250).unref?.();
    });
  }

  private async openTunnel(
    endpoint: ProxyEndpoint,
    target: URL,
    deadline: number,
  ): Promise<Tunnel> {
    const socket = await this.connectBaseSocket(endpoint);
    let stream = new StreamBuffer(socket);
    let transport: string;

    const needsTunnel =
      target.protocol === 'https:' ||
      endpoint.protocol === 'socks4' ||
      endpoint.protocol === 'socks5';
    const targetHost = target.hostname.replace(/^\[|\]$/g, '');
    const targetPort =
      target.port.length > 0 ? Number(target.port) : target.protocol === 'https:' ? 443 : 80;

    if (needsTunnel) {
      if (endpoint.protocol === 'socks5') {
        await socks5Connect(
          stream,
          {
            host: targetHost,
            port: targetPort,
            username: endpoint.username,
            password: endpoint.password,
          },
          Math.max(1, deadline - Date.now()),
        );
        transport = 'socks5-tunnel';
      } else if (endpoint.protocol === 'socks4') {
        await socks4Connect(
          stream,
          {
            host: targetHost,
            port: targetPort,
            username: endpoint.username,
            password: endpoint.password,
          },
          Math.max(1, deadline - Date.now()),
        );
        transport = 'socks4-tunnel';
      } else {
        const port = targetPort === 443 ? '' : `:${targetPort}`;
        stream.write(
          Buffer.from(
            `CONNECT ${targetHost}${port} HTTP/1.1\r\nHost: ${targetHost}${port}\r\n${
              endpoint.username
                ? `Proxy-Authorization: Basic ${Buffer.from(`${endpoint.username}:${endpoint.password ?? ''}`).toString('base64')}\r\n`
                : ''
            }Proxy-Connection: keep-alive\r\n\r\n`,
            'latin1',
          ),
        );
        transport = 'connect-tunnel';
        const reply = await readHttpResponse(stream, {
          timeoutMs: Math.max(1, deadline - Date.now()),
          maxBytes: 0,
          noBody: true,
        });
        if (reply.status !== 200) {
          socket.destroy();
          throw new ProxyHandshakeError(
            reply.status === 407 ? 'proxy_auth_failed' : 'proxy_bad_gateway',
            `CONNECT failed with status ${reply.status}`,
          );
        }
      }
    } else {
      transport = endpoint.protocol === 'https' ? 'tls-absolute-form' : 'absolute-form';
    }

    if (target.protocol === 'https:') {
      // Hand the socket to TLS; leftover bytes from the handshake belong to the tunnel.
      const leftover = stream.detach();
      stream.destroy();
      const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const tlsSocket = tls.connect({
          socket,
          servername: inspectAddress(targetHost).kind === 'hostname' ? targetHost : undefined,
          rejectUnauthorized: true,
          ALPNProtocols: ['http/1.1'],
          timeout: Math.max(1, deadline - Date.now()),
        });
        const onError = (error: Error): void => {
          tlsSocket.destroy();
          reject(error);
        };
        tlsSocket.once('error', onError);
        tlsSocket.once('timeout', () => onError(new Error('TLS handshake timed out')));
        tlsSocket.once('secureConnect', () => {
          tlsSocket.removeListener('error', onError);
          tlsSocket.removeListener('timeout', onError);
          resolve(tlsSocket);
        });
      });
      stream = new StreamBuffer(secure, leftover);
      secure.setTimeout(0);
      transport = `${transport}+tls`;
    }

    return { socket, stream, transport };
  }

  /**
   * Performs one request through a proxy. Never throws for expected failure modes — the returned
   * `ProxyResponse.error` carries a classified transport code instead.
   */
  async request(
    endpoint: ProxyEndpoint,
    rawUrl: string,
    requestOptions: ProxyRequestOptions = {},
  ): Promise<ProxyResponse> {
    const started = Date.now();
    const timeoutMs = requestOptions.timeoutMs ?? this.options.timeoutMs;
    const maxBytes = requestOptions.maxResponseBytes ?? this.options.maxResponseBytes;
    const deadline = started + timeoutMs;

    try {
      this.assertEndpointAllowed(endpoint);
    } catch (error) {
      const classified = errorCode(error);
      return {
        ...failedResponse(classified.code, classified.message, started),
        transport: 'rejected',
      };
    }

    const urlCheck = checkUrlPolicy(rawUrl, { allowPrivate: this.options.allowPrivateEndpoints });
    if (!urlCheck.ok) {
      return {
        ...failedResponse('blocked_by_policy', `target url rejected: ${urlCheck.reason}`, started),
        transport: 'rejected',
      };
    }
    const target = urlCheck.url;
    try {
      this.assertTargetAllowed(target);
    } catch (error) {
      const classified = errorCode(error);
      return {
        ...failedResponse(classified.code, classified.message, started),
        transport: 'rejected',
      };
    }

    let tunnel: Tunnel | null = null;
    try {
      tunnel = await this.openTunnel(endpoint, target, deadline);
      const absoluteForm =
        target.protocol !== 'https:' &&
        (endpoint.protocol === 'http' || endpoint.protocol === 'https');
      const requestPath = absoluteForm
        ? absoluteFormTarget(target)
        : `${target.pathname || '/'}${target.search}`;
      const headers: Record<string, string> = {
        accept: '*/*',
        'user-agent': 'ProxyPulseBot/1.0',
        ...(requestOptions.headers ?? {}),
      };
      if (absoluteForm && endpoint.username) {
        headers['Proxy-Authorization'] =
          `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password ?? ''}`, 'utf8').toString('base64')}`;
      }
      tunnel.stream.write(
        Buffer.from(
          buildHttpRequest(requestOptions.method ?? 'GET', requestPath, target.host, headers),
          'latin1',
        ),
      );

      // The body is always read (it is part of what we are measuring); includeBody only decides
      // whether the decoded text is kept and returned.
      const response = await readHttpResponse(tunnel.stream, {
        timeoutMs: Math.max(1, deadline - Date.now()),
        maxBytes,
      });

      const latencyMs = Date.now() - started;
      const bodyText = response.body.length > 0 ? response.body.toString('utf8') : '';
      const statusOk = response.status >= 200 && response.status < 400;
      return {
        ok: statusOk && !response.truncated,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        bodyBytes: response.body.length,
        bodyText: requestOptions.includeBody === false ? '' : bodyText,
        truncated: response.truncated,
        latencyMs,
        transport: tunnel.transport,
      };
    } catch (error) {
      const classified = errorCode(error);
      const response = failedResponse(classified.code, classified.message, started);
      return { ...response, transport: tunnel?.transport };
    } finally {
      try {
        tunnel?.stream.destroy();
      } catch {
        /* ignore */
      }
      try {
        tunnel?.socket.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  /** Human readable proxy identity for logs (credentials never included). */
  describe(endpoint: ProxyEndpoint): string {
    return formatProxyRedacted(endpoint);
  }
}
