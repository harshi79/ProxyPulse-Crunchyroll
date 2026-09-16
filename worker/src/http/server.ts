/**
 * The worker's HTTP surface: a tiny node:http server with two faces.
 *
 *   - unauthenticated liveness: `/health`, `/ready`
 *   - bearer-token internal API under `/internal/*` — the only thing the Cloudflare gateway may talk to
 *
 * It exposes no credentials, caps request bodies, and logs exactly one redacted line per request.
 * Public rate limiting and caching live in the Cloudflare gateway; this server is never given a
 * public DNS name of its own.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  buildMeta,
  constantTimeEqual,
  envelope,
  errorFields,
  failureBody,
  HTTP_STATUS_FOR_ERROR,
  LOG_EVENTS,
  newRequestId,
  safePublicMessage,
  type ApiErrorCode,
  type Logger,
} from '@proxypulse/shared';

import {
  cyclesView,
  healthView,
  poolView,
  randomView,
  statsView,
  tpoolView,
  type ViewContext,
  type ViewResult,
} from '../views.js';
import type { WorkerConfig } from '../config.js';
import type { SchedulerStatus } from '../pipeline/scheduler.js';

/** Very small fixed-window limiter; it only protects the internal API from a runaway caller. */
class FixedWindow {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {
    this.timer = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
    this.timer.unref?.();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }

  check(key: string): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.max - 1, retryAfterSeconds: 0 };
    }
    entry.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    if (entry.count > this.max) return { allowed: false, remaining: 0, retryAfterSeconds };
    return { allowed: true, remaining: Math.max(0, this.max - entry.count), retryAfterSeconds };
  }

  dispose(): void {
    clearInterval(this.timer);
    this.hits.clear();
  }
}

export interface HttpDeps {
  config: WorkerConfig;
  logger: Logger;
  views: ViewContext;
  /** Triggers an immediate cycle; `started` is false when one is already running. `wait` blocks until it finishes. */
  runCycle: (options: {
    wait?: boolean;
  }) => Promise<{ started: boolean; cycle_id?: string | null }>;
  /** Enqueues a single job (VALIDATE / SERVICE_CHECK / RECHECK) outside the cycle schedule. */
  enqueueJob: (body: unknown) => Promise<{ accepted: boolean; job_id?: string; error?: string }>;
  status: () => SchedulerStatus;
  ready: () => Promise<boolean> | boolean;
  version: string;
  rateLimit?: { windowMs: number; max: number };
}

interface RouteContext {
  url: URL;
  deps: HttpDeps;
  requestId: string;
  body: unknown;
}

type RouteResult = ViewResult | { raw: string; contentType: string };

interface Route {
  method: 'GET' | 'POST';
  path: string;
  auth: boolean;
  handler: (ctx: RouteContext) => Promise<RouteResult>;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

const headers = (
  requestId: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  'content-type': 'application/json; charset=utf-8',
  'x-request-id': requestId,
  'x-proxypulse-service': 'proxypulse-worker',
  'cache-control': 'no-store',
  ...extra,
});

const isRaw = (value: RouteResult): value is { raw: string; contentType: string } =>
  typeof (value as { raw?: unknown }).raw === 'string';

/** `Authorization: Bearer <token>` or `x-proxypulse-internal-token`, compared in constant time. */
export function isAuthorized(req: IncomingMessage, token: string): boolean {
  if (!token) return false;
  const header = req.headers.authorization;
  const bearer =
    typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : '';
  const custom =
    typeof req.headers['x-proxypulse-internal-token'] === 'string'
      ? req.headers['x-proxypulse-internal-token']
      : '';
  const provided = bearer || custom;
  if (!provided) return false;
  return constantTimeEqual(provided, token);
}

/** Generates a strong internal token (used by `npm run token`). */
export function generateInternalToken(): string {
  return `pp_${randomBytes(24).toString('base64url')}`;
}

export function buildRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: '/health',
      auth: false,
      handler: async (ctx) => healthView(ctx.deps.views),
    },
    {
      method: 'GET',
      path: '/ready',
      auth: false,
      handler: async (ctx) => {
        const ready = await ctx.deps.ready();
        return {
          status: ready ? 200 : 503,
          data: { ready, service: ctx.deps.config.service, version: ctx.deps.version },
        };
      },
    },
    {
      method: 'GET',
      path: '/internal/pool',
      auth: true,
      handler: (ctx) => poolView(ctx.deps.views, ctx.url.searchParams),
    },
    {
      method: 'GET',
      path: '/internal/random',
      auth: true,
      handler: (ctx) => randomView(ctx.deps.views, ctx.url.searchParams),
    },
    {
      method: 'GET',
      path: '/internal/stats',
      auth: true,
      handler: (ctx) => statsView(ctx.deps.views, ctx.url.searchParams),
    },
    {
      method: 'GET',
      path: '/internal/tpool',
      auth: true,
      handler: (ctx) => tpoolView(ctx.deps.views),
    },
    {
      method: 'GET',
      path: '/internal/cycles',
      auth: true,
      handler: (ctx) => cyclesView(ctx.deps.views, ctx.url.searchParams),
    },
    {
      method: 'GET',
      path: '/internal/cycle/current',
      auth: true,
      handler: async (ctx) => ({
        status: 200,
        data: {
          service: ctx.deps.config.service,
          cycle: await ctx.deps.views.cycles.current(),
          scheduler: ctx.deps.status(),
        },
      }),
    },
    {
      method: 'POST',
      path: '/internal/cycle/run',
      auth: true,
      handler: async (ctx) => {
        const body = (ctx.body ?? {}) as { wait?: unknown };
        const wait = ctx.url.searchParams.get('wait') === '1' || body.wait === true;
        const result = await ctx.deps.runCycle({ wait });
        return result.started
          ? {
              status: 202,
              data: {
                started: true,
                cycle_id: result.cycle_id ?? null,
                message: 'cycle started; poll /internal/cycle/current',
              },
            }
          : {
              status: 409,
              data: {},
              error: { code: 'conflict', message: 'a refresh cycle is already running' },
            };
      },
    },
    {
      method: 'POST',
      path: '/internal/jobs',
      auth: true,
      handler: async (ctx) => {
        const result = await ctx.deps.enqueueJob(ctx.body);
        return result.accepted
          ? { status: 202, data: { accepted: true, job_id: result.job_id ?? null } }
          : {
              status: 400,
              data: {},
              error: { code: 'bad_request', message: result.error ?? 'job rejected' },
            };
      },
    },
    {
      method: 'GET',
      path: '/internal/metrics',
      auth: true,
      handler: async (ctx) => {
        const stats = await statsView(ctx.deps.views, new URLSearchParams());
        const num = (key: string): number => Number(stats.data[key] ?? 0) || 0;
        const scheduler = ctx.deps.status();
        const lines = [
          '# HELP proxypulse_up 1 when the worker can read its database',
          '# TYPE proxypulse_up gauge',
          'proxypulse_up 1',
          '# HELP proxypulse_pool_size Proxies currently eligible for the public pool',
          '# TYPE proxypulse_pool_size gauge',
          `proxypulse_pool_size ${num('pool_size')}`,
          '# HELP proxypulse_proxies Proxies known to the system, by status',
          '# TYPE proxypulse_proxies gauge',
          `proxypulse_proxies{status="active"} ${num('active')}`,
          `proxypulse_proxies{status="quarantined"} ${num('quarantined')}`,
          `proxypulse_proxies{status="dead"} ${num('dead')}`,
          `proxypulse_proxies{status="pending"} ${num('pending')}`,
          '# HELP proxypulse_service_passed Proxies that passed the authorised service check',
          '# TYPE proxypulse_service_passed gauge',
          `proxypulse_service_passed{service="${ctx.deps.config.service}"} ${num('service_passed')}`,
          '# HELP proxypulse_avg_latency_ms Mean validated proxy latency',
          '# TYPE proxypulse_avg_latency_ms gauge',
          `proxypulse_avg_latency_ms ${Number(stats.data.avg_latency_ms ?? 0) || 0}`,
          '# HELP proxypulse_cycles_total Cycles since process start, by result',
          '# TYPE proxypulse_cycles_total counter',
          `proxypulse_cycles_total{result="completed"} ${Number(scheduler.cycles_completed ?? 0) || 0}`,
          `proxypulse_cycles_total{result="failed"} ${Number(scheduler.cycles_failed ?? 0) || 0}`,
          '# HELP proxypulse_uptime_ms Worker uptime',
          '# TYPE proxypulse_uptime_ms gauge',
          `proxypulse_uptime_ms ${Number(scheduler.uptime_ms ?? 0) || 0}`,
        ];
        return {
          raw: `${lines.join('\n')}\n`,
          contentType: 'text/plain; version=0.0.4; charset=utf-8',
        };
      },
    },
  ];
}

export function createWorkerServer(deps: HttpDeps): { server: Server; stop: () => Promise<void> } {
  const routes = buildRoutes();
  const limiter = new FixedWindow(deps.rateLimit?.windowMs ?? 60_000, deps.rateLimit?.max ?? 240);
  const maxBody = deps.config.security.maxRequestBytes;

  async function readBody(
    req: IncomingMessage,
  ): Promise<{ value?: unknown; tooLarge?: boolean; invalid?: boolean }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.length;
      if (size > maxBody) return { tooLarge: true };
      chunks.push(buffer);
    }
    if (size === 0) return {};
    try {
      return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
    } catch {
      return { invalid: true };
    }
  }

  const send = (
    res: ServerResponse,
    status: number,
    body: string,
    extra: Record<string, string> = {},
  ): void => {
    if (res.writableEnded || res.headersSent) return;
    res.writeHead(status, extra);
    res.end(body);
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const inbound =
      typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : '';
    const requestId = REQUEST_ID_PATTERN.test(inbound) ? inbound : newRequestId();
    const method = req.method ?? 'GET';
    let path = '/';
    let url: URL;
    let status = 500;

    try {
      const host =
        typeof req.headers.host === 'string' && req.headers.host.length > 0
          ? req.headers.host
          : 'localhost';
      url = new URL(req.url ?? '/', `http://${host}`);
      path = url.pathname.replace(/\/{2,}/g, '/');
      if (path.length > 512) {
        status = 414;
        return send(
          res,
          status,
          JSON.stringify(failureBody('bad_request', 'path too long', requestId)),
          headers(requestId),
        );
      }

      const client = req.socket.remoteAddress ?? 'unknown';
      const limit = limiter.check(client);
      if (!limit.allowed) {
        status = 429;
        return send(
          res,
          status,
          JSON.stringify(failureBody('rate_limited', 'too many requests', requestId)),
          headers(requestId, { 'retry-after': String(limit.retryAfterSeconds) }),
        );
      }

      const pathname = path.length > 1 ? path.replace(/\/$/, '') : path;
      const match = routes.find((route) => route.path === pathname);
      const route = match && match.method === method ? match : undefined;
      if (!route) {
        const code: ApiErrorCode = match ? 'method_not_allowed' : 'not_found';
        status = HTTP_STATUS_FOR_ERROR[code];
        return send(
          res,
          status,
          JSON.stringify(
            failureBody(
              code,
              match ? `${method} is not allowed on ${pathname}` : 'not found',
              requestId,
            ),
          ),
          headers(requestId, match ? { allow: match.method } : {}),
        );
      }

      if (route.auth && !isAuthorized(req, deps.config.internalApiToken)) {
        status = 401;
        return send(
          res,
          status,
          JSON.stringify(
            failureBody('unauthorized', 'missing or invalid internal token', requestId),
          ),
          headers(requestId, {
            'www-authenticate': 'Bearer',
          }),
        );
      }

      let body: unknown;
      if (method === 'POST') {
        const parsed = await readBody(req);
        if (parsed.tooLarge || parsed.invalid) {
          // We stopped reading early: drain whatever is left and close the socket, otherwise the
          // half-read request poisons a keep-alive connection that the next caller would inherit.
          status = parsed.tooLarge ? 413 : 400;
          req.resume();
          return send(
            res,
            status,
            JSON.stringify(
              failureBody(
                parsed.tooLarge ? 'payload_too_large' : 'bad_request',
                parsed.tooLarge ? 'request body too large' : 'request body must be valid JSON',
                requestId,
              ),
            ),
            headers(requestId, { connection: 'close' }),
          );
        }
        body = parsed.value;
      }

      const result = await route.handler({ url, deps, requestId, body });
      if (isRaw(result)) {
        status = 200;
        return send(
          res,
          status,
          result.raw,
          headers(requestId, { 'content-type': result.contentType }),
        );
      }
      if (result.error) {
        status = result.status;
        return send(
          res,
          status,
          JSON.stringify(
            failureBody(result.error.code, safePublicMessage(result.error.message), requestId),
          ),
          headers(requestId),
        );
      }
      status = result.status;
      const meta = buildMeta({
        request_id: requestId,
        service: deps.config.service,
        pool_size:
          result.meta?.pool_size ??
          (typeof result.data.pool_size === 'number' ? result.data.pool_size : null),
        last_update:
          result.meta?.last_update ??
          (typeof result.data.last_update === 'string' ? result.data.last_update : null),
      });
      send(res, status, JSON.stringify(envelope(result.data, meta)), headers(requestId));
    } catch (error) {
      deps.logger.error('unhandled request error', {
        event: LOG_EVENTS.API_REQUEST,
        request_id: requestId,
        method,
        path,
        ...errorFields(error),
      });
      send(
        res,
        500,
        JSON.stringify(failureBody('internal_error', 'internal error', requestId)),
        headers(requestId),
      );
    } finally {
      deps.logger.info('request', {
        event: LOG_EVENTS.API_REQUEST,
        request_id: requestId,
        method,
        path,
        status,
        duration_ms: Date.now() - startedAt,
      });
    }
  }

  server.on('clientError', (error, socket) => {
    deps.logger.warn('rejected malformed HTTP request', {
      event: LOG_EVENTS.API_REQUEST,
      ...errorFields(error),
    });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  const stop = async (): Promise<void> =>
    new Promise<void>((resolve) => {
      limiter.dispose();
      server.closeAllConnections();
      server.close(() => resolve());
    });

  return { server, stop };
}
