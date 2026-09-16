/**
 * Discovery orchestration: fan out over enabled providers with bounded concurrency and retries,
 * normalize + dedupe their output, reject malformed entries and never let one bad source break the
 * cycle (each source outcome is recorded, failures are logged and counted).
 */

import {
  attemptWithRetry,
  dedupeKeyHash,
  LOG_EVENTS,
  mapWithConcurrency,
  type Logger,
  type NormalizedProxy,
} from '@proxypulse/shared';

import type { DiscoveryContext, DiscoveryProvider, ProviderResult } from './providers.js';

export interface SourceOutcome {
  source: string;
  status: 'ok' | 'failed';
  accepted: number;
  rejected: number;
  duplicates: number;
  fetched_lines: number;
  bytes: number;
  duration_ms: number;
  attempts: number;
  error: string | null;
  note: string | null;
}

export interface DiscoveryResult {
  candidates: NormalizedProxy[];
  /** dedupe key -> source id, so callers know where a candidate came from. */
  sourceByDedupeKey: Map<string, string>;
  /** dedupe key -> relative trust of the source that reported it. */
  trustByDedupeKey: Map<string, number>;
  per_source: SourceOutcome[];
  totals: {
    discovered: number;
    accepted: number;
    rejected: number;
    duplicates: number;
    sources_ok: number;
    sources_failed: number;
    duration_ms: number;
  };
}

export interface DiscoveryServiceOptions {
  providers: DiscoveryProvider[];
  concurrency: number;
  retries: number;
  backoffBaseMs: number;
  candidateCap: number;
  logger: Logger;
  context: Omit<DiscoveryContext, 'logger'>;
}

const RETRYABLE = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  // A client error or a robots.txt refusal is a policy answer, not a blip: do not hammer about it.
  if (/status 4\d\d/.test(message) || /robots\.txt/.test(message)) return false;
  return true;
};

export class DiscoveryService {
  constructor(private readonly options: DiscoveryServiceOptions) {}

  async run(): Promise<DiscoveryResult> {
    const startedAt = Date.now();
    const { providers, logger, context } = this.options;
    logger.info('discovery started', {
      event: LOG_EVENTS.DISCOVERY_STARTED,
      sources: providers.length,
      concurrency: this.options.concurrency,
      cycle_id: context.cycleId,
    });

    const perSource: (SourceOutcome | null)[] = new Array(providers.length).fill(null);
    const results: (ProviderResult | null)[] = new Array(providers.length).fill(null);

    const settled = await mapWithConcurrency(
      providers,
      this.options.concurrency,
      async (provider, index) => {
        const sourceStarted = Date.now();
        try {
          const { value: result, attempts } = await attemptWithRetry(
            () => provider.fetch({ ...context, logger: providerLogger(logger, provider.id) }),
            {
              attempts: this.options.retries,
              baseDelayMs: this.options.backoffBaseMs,
              maxDelayMs: 5_000,
              jitter: 0.3,
              retryable: RETRYABLE,
              ...(context.signal ? { signal: context.signal } : {}),
            },
          );
          perSource[index] = {
            source: provider.id,
            status: 'ok',
            accepted: result.proxies.length,
            rejected: result.rejected.length,
            duplicates: result.duplicates,
            fetched_lines: result.fetched_lines,
            bytes: result.bytes,
            duration_ms: Date.now() - sourceStarted,
            attempts,
            error: null,
            note: result.note,
          };
          results[index] = result;
          logger.info('source fetched', {
            event: LOG_EVENTS.DISCOVERY_SOURCE_COMPLETED,
            source: provider.id,
            cycle_id: context.cycleId,
            accepted: result.proxies.length,
            rejected: result.rejected.length,
            duplicates: result.duplicates,
            bytes: result.bytes,
            duration_ms: Date.now() - sourceStarted,
            attempts,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          perSource[index] = {
            source: provider.id,
            status: 'failed',
            accepted: 0,
            rejected: 0,
            duplicates: 0,
            fetched_lines: 0,
            bytes: 0,
            duration_ms: Date.now() - sourceStarted,
            attempts: this.options.retries,
            error: message.slice(0, 240),
            note: null,
          };
          // Graceful: a failing source is recorded and the cycle continues.
          logger.warn('source failed', {
            event: LOG_EVENTS.DISCOVERY_SOURCE_FAILED,
            source: provider.id,
            cycle_id: context.cycleId,
            error_message: message.slice(0, 240),
            duration_ms: Date.now() - sourceStarted,
          });
        }
      },
    );
    void settled;

    const seen = new Set<string>();
    const candidates: NormalizedProxy[] = [];
    const sourceByDedupeKey = new Map<string, string>();
    const trustByDedupeKey = new Map<string, number>();
    let discovered = 0;
    let rejected = 0;
    let duplicates = 0;

    let capped = false;
    for (let index = 0; index < providers.length; index++) {
      const provider = providers[index];
      const result = results[index];
      if (!provider || !result) continue;
      // Stats always add up, even past the cap: every source was fetched either way.
      discovered += result.fetched_lines;
      rejected += result.rejected.length;
      duplicates += result.duplicates;

      // Keys are the hash the database stores in `proxies.dedupe_key`, so downstream joins (source
      // attribution, trust weighting) need no re-derivation.
      for (const proxy of result.proxies) {
        const key = dedupeKeyHash(proxy);
        if (capped || seen.has(key)) {
          duplicates += 1;
          continue;
        }
        seen.add(key);
        candidates.push(proxy);
        sourceByDedupeKey.set(key, provider.id);
        trustByDedupeKey.set(key, provider.trust);
        if (candidates.length >= this.options.candidateCap) capped = true;
      }
    }

    const outcomes = perSource.filter((outcome): outcome is SourceOutcome => outcome !== null);
    const totals = {
      discovered,
      accepted: candidates.length,
      rejected,
      duplicates,
      sources_ok: outcomes.filter((outcome) => outcome.status === 'ok').length,
      sources_failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
      duration_ms: Date.now() - startedAt,
    };

    logger.info('discovery completed', {
      event: LOG_EVENTS.DISCOVERY_COMPLETED,
      cycle_id: context.cycleId,
      ...totals,
    });

    return { candidates, sourceByDedupeKey, trustByDedupeKey, per_source: outcomes, totals };
  }
}

const providerLogger = (logger: Logger, source: string): Logger =>
  logger.child('discovery', { source });
