# Architecture

ProxyPulse is one deployable pipeline (the worker) and one deployable read path (the Cloudflare
gateway). Everything else is a library in this repository. There is no ORM, no queue requirement, and
no component that has to be reachable from the internet except the gateway.

```
                     ┌──────────────────────── Cloudflare Worker (api/) ───────────────────────┐
  client ──HTTPS──▶  │ auth (reader keys) · rate limit (KV) · edge cache · envelope + request id│
                     └───────────────┬──────────────────────────────────────────────────────────┘
                                     │  Bearer INTERNAL_API_TOKEN  (never leaves the two services)
                                     ▼
  ┌──────────────────────────── Render web service (worker/) ───────────────────────────────┐
  │  scheduler (15 min, single-flight)  →  pipeline.runCycle()                               │
  │  internal JSON API  /internal/{pool,random,stats,tpool,cycles,metrics}  + /health /ready  │
  │                                                                                           │
  │  discovery ─▶ policy filter ─▶ upsert ─▶ validation (queue) ─▶ service check (rate limited)│
  │                                          │                        │                       │
  │                                          ▼                        ▼                       │
  │                                    pool manager: score → status transitions → sweeps       │
  └───────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                   ▼
                                    Turso / libSQL  (proxies, validation_results,
                                                       service_results, refresh_cycles, meta)
```

## Workspaces

| Package                 | Name                              | Responsibility                                                                                                                                                                                                                                                                                        |
| ----------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/`               | `@proxypulse/shared`              | Runtime-agnostic domain logic. Parses and normalises proxy entries, classifies addresses, applies URL policy, computes scores, builds the API envelope, structured logging, redaction, concurrency helpers. Imports nothing Node- or Worker-specific, so the Cloudflare Worker can reuse it verbatim. |
| `db/`                   | `@proxypulse/db`                  | libSQL client (`file:`, `:memory:`, `libsql://`), SQL-file migrations, and the five repositories. Plain SQL, chunked writes, one round-trip batches.                                                                                                                                                  |
| `services/crunchyroll/` | `@proxypulse/service-crunchyroll` | The authorised service adapter: probe config + robots handling, response→verdict rules, verdict→quality scorer.                                                                                                                                                                                       |
| `worker/`               | `@proxypulse/worker`              | Everything that touches the network and the clock: discovery providers, validation engine, pool manager, queue drivers, the cycle, the scheduler, the internal HTTP API, and the composition root.                                                                                                    |
| `api/`                  | `@proxypulse/api`                 | Cloudflare Worker: the only public surface.                                                                                                                                                                                                                                                           |

Build order matters: `shared → db → services/crunchyroll → worker`, each typechecking against the
upstream package's emitted `.d.ts` (no project references, no path aliases in production code).

## The refresh cycle

One cycle (`worker/src/pipeline/cycle.ts`) runs these phases in order. It is single-flight: the
scheduler and `POST /internal/cycle/run` share one mutex-like guard, so cycles never overlap.

1. **Cycle start.** A `refresh_cycles` row is inserted (`status = 'running'`) and `meta.scheduler.*`
   is updated. Abandoned rows from a previous crash are recovered first (running cycles marked
   `failed`, their `pending` proxies released back to the backlog).
2. **Discovery.** Enabled providers are fetched with bounded concurrency and a bounded number of
   attempts per source. Before a remote source is fetched at all, its `robots.txt` is evaluated for our
   user agent (cached per origin for an hour, `Crawl-delay` honoured as a minimum spacing): a disallow —
   or a `robots.txt` that cannot be read — stops that source for the cycle instead of being ignored.
   `respectRobots: false` exists only for inventories you operate yourself. Each source returns candidate strings; parsing normalises `scheme://`,
   `host:port`, `host:port:user:pass`, bracketed IPv6, per-line protocol labels (`SOCKS5`) and
   credential forms. Malformed lines are counted with a machine-readable reason, never fatal. A source
   that fails is recorded (`per_source` outcome) and the cycle continues. The merged result is deduped
   across sources and hard-capped (`DISCOVERY_CANDIDATE_CAP`).
3. **Policy filter.** Every candidate is checked against the address policy _before_ anything dials it
   (see [Security](#security-model)). Blocked endpoints are counted and dropped.
4. **Upsert.** Survivors are upserted by `dedupe_key` (a hash of `protocol|host|port|username`).
   Existing rows keep their history (`first_seen`, counters, scores, source); only `last_seen` and the
   source attribution move. New rows enter as `status = 'new'`.
5. **Validation queue.** `selectValidationQueue` picks a bounded batch: fresh `new` rows
   (`POOL_MAX_NEW_PER_CYCLE`), `quarantined` rows for a review attempt, and `active` rows whose
   `last_checked_at` is older than `POOL_RECHECK_AFTER_MINUTES`. Those rows are marked `pending` with
   the cycle id (a crash therefore cannot strand them: the next cycle releases them).
6. **Connectivity validation.** For each queued proxy the checker issues one HTTP request _through_
   the proxy to `VALIDATION_CHECK_URL` using the protocol-appropriate transport (absolute-form for
   http/https proxies, SOCKS4/SOCKS5 handshake otherwise, CONNECT tunnel for TLS targets). It records
   reachable/not, latency, HTTP status, attempts used, transport string and (optionally) the egress
   address the target observed. Transient failures are retried up to `VALIDATION_RETRIES` total attempts
   with jittered backoff; refusals and policy blocks are never retried. `VALIDATION_MAX_PER_CYCLE` caps
   the work per cycle. Jobs flow through the queue abstraction so the same code path works with or
   without Cloudflare Queues.
7. **Service check.** Only then, and only for proxies above `CR_MIN_SCORE` that do not already hold a
   fresh verdict, the Crunchyroll adapter probes `CR_CHECK_URL` through the proxy — under a token
   bucket (`CR_RATE_LIMIT_PER_MINUTE`), a per-cycle budget (`CR_MAX_CHECKS_PER_CYCLE`), a minimum
   spacing, a `Retry-After`-driven global cooldown, and a circuit breaker (25 failures → open 120 s).
8. **Scoring + status transitions.** `PoolManager.planValidation` / `planService` compute the new score
   and status for each row, then `persistValidationOutcomes` / `persistServiceOutcomes` write both the
   rows and the history tables in batched statements.
9. **Pool sweeps (`finalize`).** `expireStale` (no success within `POOL_TTL_MINUTES` → `dead`),
   `quarantineFailures` (consecutive failures ≥ threshold → `quarantined`), `enforcePoolCapacity`
   (lowest scores beyond `POOL_MAX_ACTIVE`, 5 000 by default → `quarantined`), release of leftover claims. **Nothing is
   deleted wholesale** — this is what "rolling pool" means here.
10. **Statistics.** `/stats` inputs are recomputed and snapshotted into `meta.cache.stats_snapshot` so
    the gateway can be served from a cheap read, and the cycle row is completed with counters
    (discovered / checked / passed / failed / service checks / pool size / duration).
11. **Maintenance (once a day).** `pruneHistory` trims `validation_results`, `service_results`,
    long-dead proxies and old `refresh_cycles` rows according to `RETENTION_*`.

A cycle never throws at its caller: failures are recorded in `refresh_cycles.error`,
`meta.scheduler.last_cycle_error`, and the returned `CycleReport`.

## Data model

No ORM, five tables plus the migration ledger (`db/migrations/001_init.sql`).

**`proxies`** — one row per endpoint (`host`, `port`, `protocol`, `username`, `password`, `dedupe_key`
UNIQUE). Pool state: `status`, `validation_status`, `service_status`, `score`, `latency_ms`,
`service_latency_ms`, `last_error_code`, `consecutive_failures`, `check_count`, `pass_count`,
`first_seen`, `last_seen`, `last_checked_at`, `last_passed_at`, `service_checked_at`,
`first/last_cycle_id`, `country`, `anonymity`, `source`, `notes`. Indexes cover the pool read
(`status, score DESC, last_passed_at DESC`), the service-filtered read, `host:port` lookups, the
recheck sweep and per-source reporting.

**`validation_results`** — append-only per-attempt history: `proxy_id`, `cycle_id`, `created_at`,
`reachable`, `latency_ms`, `protocol`, `transport`, `http_status`, `error_code`, `error_message`
(pre-redacted), `attempts`, `duration_ms`.

**`service_results`** — one row per probe: `service`, `status` in
`passed|failed|blocked|skipped`, `http_status`, `latency_ms`, `reason`, `details` (small allow-listed
JSON summary).

**`refresh_cycles`** — the audit trail of every cycle with all counters and the failure text.

**`meta`** — key/value with an allow-listed key set (`scheduler.next_run_at`,
`scheduler.current_cycle_id`, `scheduler.last_completed_cycle_id`, `scheduler.last_cycle_error`,
`cache.stats_snapshot`, `maintenance.last_prune_at`). One row per fact, rather than columns on a
singleton row, because the scheduler writes these from different places at different times and the API
reads them on every response.

Credentials live only in `proxies.username/password`. They are read inside the worker process to dial a
proxy and are **never** selected into `readPool`, never written to a queue payload, never logged.

## Proxy status machine

```
                       ┌────────────────────────── pass & score ≥ POOL_MIN_SCORE ──────────────┐
                       ▼                                                                        ▼
   new ──queued──▶ pending ──▶ active ◀── one transient miss (transient_failure:N, stays active)  pool
                       │  │                                                                        ▲
                       │  └── pass but score < floor ──▶ quarantined (low_score:N) ── recheck pass ┘
                       │
                       └── fail ──▶ consecutive_failures++
                                     ├─ < threshold, was active  → active (grace)
                                     ├─ ≥ threshold              → quarantined (failures:N)
                                     └─ ≥ 3× threshold and never passed → dead (unrecoverable)
```

`dead` and expired rows are excluded from every pool read; nothing is deleted until retention pruning.

## Scoring

`shared/src/scoring.ts` (weights fixed by the spec, all overridable via `SCORE_*`):

| Factor      | Weight | Notes                                                                                     |
| ----------- | ------ | ----------------------------------------------------------------------------------------- |
| reliability | 0.35   | `pass_count / check_count`; 0.5 head start on the first check                             |
| latency     | 0.20   | 1 at `SCORE_IDEAL_LATENCY_MS` (200 ms), 0 at `SCORE_MAX_LATENCY_MS` (3 s), linear between |
| freshness   | 0.15   | `0.5 ^ (minutes since last pass / 45)`                                                    |
| service     | 0.25   | verdict factor: passed 1, untested 0.45, skipped 0.3, failed 0.1, blocked 0               |
| quality     | 0.05   | source trust × anonymity (elite 1, anonymous 0.75, unknown 0.6, transparent 0.4)          |

Plus a flat `−12` per consecutive failure, `0` if the last connectivity check failed, and a
`minPoolScore` floor (25) for pool membership. The service adapter's own quality factor is combined
with the connectivity score by `combineScores(connectivity, quality)` with `connectivityWeight = 0.55`;
when there is **no** service verdict (checks disabled, budget spent, breaker open) the connectivity
score stands alone so policy can never empty the pool.

## Security model

**Outbound (SSRF).** Two layers, both fail closed:

- _Before dialling_: `shared/src/ip.ts` refuses loopback, RFC1918/CGNAT, link-local (including
  `169.254.169.254` and `fd00:ec2::/64`), multicast, unspecified and reserved ranges, and rejects
  non-canonical IP literals (`0177.0.0.1`, `0x7f.0.0.1`, `2130706433`, `127.1`) that `getaddrinfo`
  would happily reinterpret. `shared/src/url-policy.ts` additionally refuses non-`http(s)` schemes,
  credentials in URLs, control characters, oversized URLs, port 25, the `.localhost` namespace, and
  metadata hostnames — the metadata block is **not** lifted by the dev escape hatch.
- _After resolution_: `worker/src/net/safe-lookup.ts` performs DNS itself, classifies every returned
  record and pins the socket to the address it approved (`net.connect({ lookup })`), so a public name
  that resolves to `127.0.0.1` cannot be used to reach the host's own services. Results are cached
  briefly with the policy verdict baked into the cache key.

`ALLOW_PRIVATE_ENDPOINTS=1` (never in production) only relaxes the private ranges so the local mocks
and tests can be dialled; it always leaves metadata endpoints blocked.

**Input validation.** Every public query parameter is parsed and clamped at the edge (`limit` ≤ 500,
`offset` ≤ 100 000, protocol/country/service enums, integer-only filters). The internal API accepts
JSON bodies only up to `MAX_REQUEST_BYTES`, rejects non-JSON and oversized bodies with 413/400, and
drains the rest of an aborted upload so a half-read request cannot poison a keep-alive connection.

**Credentials and logs.** `shared/src/redact.ts` redacts URL userinfo and secret-shaped keys; the proxy
description used in every log line is `formatProxyRedacted()` (`socks5://***:***@host:port`). Tokens
are compared in constant time. Queue payloads contain identifiers only (`job_id`, `type`, `cycle_id`,
`proxy_id`) — never host, port, credentials or URLs — which is what makes the queue safe to inspect in
a third-party dashboard.

**Authorisation.** The worker's internal API requires the bearer (or `x-proxypulse-internal-token`)
header on everything except `/health` and `/ready`. The gateway is the only intended client; the
Render service is deployed as an internal-origin web service and is never documented as public. Public
readers authenticate with keys in `API_PUBLIC_KEYS`; the key is fingerprinted for rate-limit bucketing
and is never forwarded upstream or logged.

## Queues

`worker/src/queue/` is a two-implementation contract (`JobQueue`) with one code path in the pipeline:
produce jobs, then `consume(handler, { drainOnly, maxJobs })`.

- **memory** (default): bounded in-process backlog, per-job attempt counting, requeue at the tail so a
  hot failing job cannot starve the rest. Zero external dependencies.
- **cloudflare**: producer `POST /messages` (chunked at 100 per request), consumer `POST /messages/pull`
  with a visibility timeout, `POST /messages/ack` carrying `acks` and `retries` — i.e. the documented
  HTTP-pull-consumer flow, so the worker can consume a Cloudflare queue without a Worker binding. Enable
  with `QUEUE_DRIVER=cloudflare`; without the three `CLOUDFLARE_*` variables startup fails loudly rather
  than silently degrading.

Manual jobs (`POST /internal/jobs`) are validated, enqueued and then drained immediately when no cycle is
running; otherwise they are picked up by the next cycle. The queue is an implementation detail of the
pipeline, not a requirement for correct operation.

## The service adapter

`services/crunchyroll/` answers one question: _can this proxy complete an ordinary, unauthenticated
HTTPS request against an endpoint we are permitted to fetch?_ Design constraints, all enforced in code:

- The probe URL must be on `CR_ALLOWED_HOSTS` and must not be the site root; the adapter's requester is
  constructed with the same allow-list, so a misconfiguration cannot redirect probing traffic elsewhere.
- `robots.txt` for `CR_USER_AGENT` is fetched once per cycle (cached 6 h) and **fails closed**: if it
  cannot be read, or it disallows the path, checks are skipped with a reason instead of performed.
  A `Crawl-delay` widens the request spacing.
- A `429`/`503` (or any `Retry-After`) installs a global cooldown for the whole adapter, not just that
  proxy. Repeated failures open a circuit breaker for 120 s. `maxChecksPerCycle` is a hard budget.
- Verdicts: `passed`, `failed` (proxy or transport broken, unexpected status/content), `blocked`
  (rate limit, `401/403/406/407/451`, challenge markers such as `Just a moment` or `cf-mitigated`),
  `skipped` (disabled, budget, cooldown, breaker, robots, policy block). `check()` never throws.
- There is no code path that replays a challenge, solves a CAPTCHA, spoofs a client identity, rotates
  headers to defeat fingerprinting, or retries an HTTP 451/403 "until it works". Blocked is a terminal
  verdict for that cycle; a blocked proxy is only probed again after `CR_RECHECK_AFTER_MINUTES` (6 h by
  default) with the same single polite request, and `CR_ALLOW_RETEST_BLOCKED=0` removes even that until a
  connectivity check re-qualifies it.

Adding another service means adding another `services/<name>/` package with the same three modules
(checker, rules, scorer); the pipeline only depends on `check()` and `serviceScore()`.

## Failure handling and limits

| Concern                             | Mechanism                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| Source outage / rate-limited source | bounded retries with jitter, per-source `failed` outcome, cycle continues                     |
| Slow target                         | per-request deadlines (connect + total), bounded body reads, abort on cap                     |
| Worker crash mid-cycle              | `pending` claims + `running` cycle rows are recovered at the next start                       |
| Overlapping triggers                | single-flight scheduler; `POST /internal/cycle/run` returns 409 while busy                    |
| Flood protection                    | caps on candidates, validations, service checks, pool size, response bytes, request bytes     |
| Unbounded growth                    | daily retention pruning; the pool is capped, history is windowed                              |
| Origin down for readers             | gateway serves a stale cache entry with `meta.stale = true` instead of failing                |
| Shutdown                            | SIGTERM stops the timer, waits (bounded) for the in-flight cycle, closes the queue and server |

Defaults worth remembering: 15 min cadence (+ up to 20 s jitter), 2 000 validations and 250 service
checks per cycle, 8 s validation timeout with 2 attempts, 90 min pool TTL, 3 consecutive failures before
quarantine, 120 req/60 s at the edge, `GET /pool` cached 30 s, `/random` never cached, and one
`robots.txt` lookup per origin per hour before any list is fetched.
