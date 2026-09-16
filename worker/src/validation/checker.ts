/**
 * Basic connectivity validation. A proxy must pass this before any service-specific test runs.
 *
 * The check is one small HTTP request made *through* the proxy to a fixed, public, boring endpoint
 * (default: the 204 no-content probe). It answers: does this endpoint accept connections, does it
 * forward a request, and how long does that take — with bounded retries and backoff.
 */

import {
  attemptWithRetry,
  formatProxyRedacted,
  LOG_EVENTS,
  mapWithConcurrency,
  redactText,
  type Logger,
  type ProxyEndpoint,
  type ProxyRequester,
  type ProxyResponse,
} from '@proxypulse/shared';

import { egressLooksLocal, extractEgressAddress } from './egress.js';

export interface ValidationConfig {
  concurrency: number;
  timeoutMs: number;
  retries: number;
  backoffBaseMs: number;
  maxResponseBytes: number;
  checkUrl: string;
  successStatuses: number[];
  requireEgressEcho: boolean;
  /** When true, egress on a local address is a failure instead of just a note. */
  rejectLocalEgress: boolean;
}

export interface ValidationOutcome {
  proxy: ProxyEndpoint;
  reachable: boolean;
  latency_ms: number | null;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  duration_ms: number;
  transport: string | null;
  egress: 'public' | 'local' | 'unknown';
}

/** Transient failures are worth another attempt; refusals and policy blocks are not. */
const RETRYABLE_CODES = new Set([
  'timeout',
  'connect_reset',
  'protocol_error',
  'dns_error',
  'tls_error',
]);

class RetryableProxyResponseError extends Error {
  constructor(readonly response: ProxyResponse) {
    super(response.error?.message ?? 'retryable proxy failure');
    this.name = 'RetryableProxyResponseError';
  }
}

export class ValidationChecker {
  constructor(
    private readonly deps: {
      requester: ProxyRequester;
      config: ValidationConfig;
      logger: Logger;
    },
  ) {}

  /** Validates one proxy. Never throws. */
  async validate(
    endpoint: ProxyEndpoint,
    context: { cycle_id: string; proxy_id?: number },
  ): Promise<ValidationOutcome> {
    const startedAt = Date.now();
    const { config } = this.deps;
    let attempts = 0;
    let lastResponse: ProxyResponse | null = null;
    let lastError: string | null = null;

    /**
     * The requester never throws for transport failures, so a retryable failure is converted into a
     * typed throw here — that keeps "what is retryable" in exactly one place.
     */
    const runOnce = async (): Promise<ProxyResponse> => {
      attempts += 1;
      const response = await this.deps.requester.request(endpoint, config.checkUrl, {
        method: 'GET',
        timeoutMs: config.timeoutMs,
        maxResponseBytes: config.maxResponseBytes,
        includeBody: config.requireEgressEcho,
        headers: { 'cache-control': 'no-cache' },
      });
      const code = response.error?.code;
      if (code && RETRYABLE_CODES.has(code)) throw new RetryableProxyResponseError(response);
      return response;
    };

    try {
      const { value } = await attemptWithRetry(runOnce, {
        attempts: config.retries,
        baseDelayMs: config.backoffBaseMs,
        maxDelayMs: 4_000,
        jitter: 0.35,
        retryable: (error: unknown) => error instanceof RetryableProxyResponseError,
        onRetry: (info) => {
          this.deps.logger.debug('validation retry', {
            event: LOG_EVENTS.VALIDATION_STARTED,
            cycle_id: context.cycle_id,
            proxy_id: context.proxy_id,
            attempt: info.attempt,
            delay_ms: info.delayMs,
          });
        },
      });
      lastResponse = value;
    } catch (error) {
      if (error instanceof RetryableProxyResponseError) lastResponse = error.response;
      else
        lastError = redactText(error instanceof Error ? error.message : String(error)).slice(
          0,
          200,
        );
    }

    const response = lastResponse;
    const status = response?.status ?? 0;
    const transportError = response?.error?.code ?? null;
    const statusAccepted = config.successStatuses.includes(status);
    const egress = extractEgressAddress(response?.bodyText ?? '');
    const egressKind: ValidationOutcome['egress'] =
      egress === null ? 'unknown' : egressLooksLocal(egress) ? 'local' : 'public';

    let errorCode: string | null = transportError ?? null;
    let reachable = Boolean(response?.ok) && statusAccepted && !response?.truncated;
    if (!transportError && status === 407) {
      // The proxy refused our credentials — a distinct failure mode from "the site said no".
      errorCode = 'proxy_auth_failed';
    } else if (!transportError && !statusAccepted && status > 0) {
      errorCode = 'unexpected_status';
    } else if (!response && lastError !== null) {
      errorCode = 'unknown';
    }
    if (response?.truncated) {
      errorCode = 'response_too_large';
      reachable = false;
    }
    if (config.requireEgressEcho && reachable) {
      if (egressKind === 'unknown') {
        errorCode = 'no_egress_echo';
        reachable = false;
      } else if (egressKind === 'local' && config.rejectLocalEgress) {
        // The "proxy" sent our request to our own network: that is an SSRF-shaped proxy, never a pool member.
        errorCode = 'egress_local';
        reachable = false;
      }
    }

    const outcome: ValidationOutcome = {
      proxy: endpoint,
      reachable,
      latency_ms: reachable ? (response?.latencyMs ?? null) : null,
      http_status: status > 0 ? status : null,
      error_code: reachable ? null : errorCode,
      error_message: reachable
        ? null
        : redactText(response?.error?.message ?? lastError ?? '').slice(0, 200) || null,
      attempts,
      duration_ms: Date.now() - startedAt,
      transport: response?.transport ?? null,
      egress: egressKind,
    };

    this.deps.logger.debug(outcome.reachable ? 'proxy validated' : 'proxy validation failed', {
      event: outcome.reachable
        ? LOG_EVENTS.VALIDATION_COMPLETED
        : LOG_EVENTS.VALIDATION_REJECTED_ENDPOINT,
      cycle_id: context.cycle_id,
      proxy_id: context.proxy_id,
      proxy: formatProxyRedacted(endpoint),
      reachable: outcome.reachable,
      latency_ms: outcome.latency_ms,
      error_code: outcome.error_code,
      attempts: outcome.attempts,
      duration_ms: outcome.duration_ms,
      egress: outcome.egress,
    });
    return outcome;
  }

  /** Validates a batch with bounded concurrency (the pipeline's flood protection). */
  async validateMany(
    endpoints: readonly { endpoint: ProxyEndpoint; proxy_id: number }[],
    context: {
      cycle_id: string;
      signal?: AbortSignal;
      onProgress?: (done: number, total: number) => void;
    },
  ): Promise<ValidationOutcome[]> {
    if (endpoints.length === 0) return [];
    this.deps.logger.info('validation started', {
      event: LOG_EVENTS.VALIDATION_STARTED,
      cycle_id: context.cycle_id,
      count: endpoints.length,
      concurrency: this.deps.config.concurrency,
      timeout_ms: this.deps.config.timeoutMs,
      retries: this.deps.config.retries,
    });

    const startedAt = Date.now();
    const settled = await mapWithConcurrency(
      endpoints,
      this.deps.config.concurrency,
      (item) =>
        this.validate(item.endpoint, { cycle_id: context.cycle_id, proxy_id: item.proxy_id }),
      {
        ...(context.signal ? { signal: context.signal } : {}),
        ...(context.onProgress ? { onProgress: context.onProgress } : {}),
      },
    );

    const outcomes = settled.map((result, index) =>
      result.ok
        ? result.value
        : {
            proxy: endpoints[index]!.endpoint,
            reachable: false,
            latency_ms: null,
            http_status: null,
            error_code: 'internal_error',
            error_message: redactText(
              result.error instanceof Error ? result.error.message : String(result.error),
            ).slice(0, 200),
            attempts: 0,
            duration_ms: Date.now() - startedAt,
            transport: null,
            egress: 'unknown' as const,
          },
    );

    const passed = outcomes.filter((outcome) => outcome.reachable).length;
    this.deps.logger.info('validation completed', {
      event: LOG_EVENTS.VALIDATION_COMPLETED,
      cycle_id: context.cycle_id,
      checked: outcomes.length,
      passed,
      failed: outcomes.length - passed,
      duration_ms: Date.now() - startedAt,
    });
    return outcomes;
  }
}
