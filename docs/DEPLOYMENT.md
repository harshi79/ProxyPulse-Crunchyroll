# Deployment

Three moving parts, two deploys:

```
reader ──▶ Cloudflare Worker (api/)  ──HTTPS + bearer token──▶  Render web service (worker/)
                            │                                          │
                            └──────────── reads Turso? no ─────────────┘
                                                    │
                                          Turso (libSQL) database
```

Only the Cloudflare Worker is meant to be reachable by readers. The Render service answers `/health`
for the platform and `/internal/*` for the gateway; everything it serves requires
`INTERNAL_API_TOKEN`. The database is reachable only by the worker.

Prerequisites: `npm install && npm run build` locally (the api Worker imports the _built_
`@proxypulse/shared`, so the workspaces must be compiled before `wrangler deploy` — CI and the Render
build command do this).

## Running on free tiers (it works, and this is the intended hobby setup)

Every piece has a free plan and the defaults are tuned to fit inside them:

| Service            | Free allowance                                                     | What ProxyPulse does about it                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Render web service | 512 MB RAM, 0.1 CPU, **sleeps after ~15 idle minutes**             | `render.yaml` ships `plan: free`; the Cloudflare cron trigger pokes `/health` every 5 min so it stays awake, and `RUN_CYCLE_ON_STARTUP=1` means even a cold boot refreshes the pool. Caps are lowered (`POOL_MAX_ACTIVE=5000`, `VALIDATION_MAX_PER_CYCLE=800`, `DISCOVERY_CANDIDATE_CAP=5000`) so a cycle fits in 512 MB |
| Cloudflare Workers | 100 000 requests/day, 10 ms CPU/invocation, cron triggers included | The gateway does no parsing beyond one JSON body; the cron invocation is 288/day (0.3 % of the allowance)                                                                                                                                                                                                                |
| Cloudflare KV      | 100 000 reads but only **1 000 writes/day**                        | Leave `RATE_LIMIT_KV` unbound on the free plan: the limiter then counts per isolate (soft limit) instead of exhausting your write budget. Bind the namespace when you move to a paid plan                                                                                                                                |
| Turso              | 5 GB, 1 B row reads + 25 M row writes/month                        | At 2 000 validations per cycle you would write ~6 M rows/month, so the shipped caps (800/cycle) plus daily pruning keep you far below it. `RETENTION_RESULT_DAYS=7` on a hobby DB                                                                                                                                        |
| Cloudflare Queues  | not needed                                                         | `QUEUE_DRIVER=memory` is the default: no queue, no extra account, same pipeline                                                                                                                                                                                                                                          |

Three consequences worth knowing:

1. **Free Render filesystem is ephemeral.** Never use `file:./data/proxypulse.db` there — the pool history
   (`first_seen`, counters) disappears at every restart/sleep. Use a Turso DB, even on its free plan.
2. **Sleep is not downtime for readers.** A sleeping origin only costs one cold start: the gateway serves
   the stale cache entry (`meta.stale = true`) meanwhile, and `UPSTREAM_TIMEOUT_MS` should stay ≥ 10 000
   so a warm-up can finish. The cron keep-alive exists precisely to make that rare.
3. **If you turn the cron off** (`CYCLE_TRIGGER_ENABLED=0`), set `REFRESH_INTERVAL_MINUTES` to what you
   want and accept that a sleeping instance only refreshes when a reader wakes it.

`CYCLE_TRIGGER_MODE=trigger` inverts who drives the cadence: the edge then POSTs `/internal/cycle/run`
each interval and you can set `RUN_CYCLE_ON_STARTUP=1` with a large `REFRESH_INTERVAL_MINUTES` so the
worker only reacts. Single-flight means an overlapping poke answers `409` and nothing doubles up.

## 1. Turso (or any libSQL-compatible database)

```bash
npm i -g turso-cli && turso auth login
turso db create proxypulse --group default
turso db show proxypulse --url           # → libsql://proxypulse-<org>.turso.io
turso db tokens create proxypulse        # → the auth token
```

Set on the worker:

```
DATABASE_URL=libsql://proxypulse-<org>.turso.io
DATABASE_AUTH_TOKEN=<token>
```

Nothing else is required to create the schema: migrations run at worker start
(`applyMigrations` in `@proxypulse/db`) and are idempotent, checksummed and append-only. To audit or
migrate ahead of a deploy: `npm run db:migrate` / `npm run db:status` (locally, with the same
`DATABASE_URL`).

A single-file `file:./data/proxypulse.db` database works too (Fly.io volume, a VM, a container).
`:memory:` is for tests only: the pool evaporates with the process.

## 2. Render (worker + scheduler + internal API)

**Blueprint:** push this repository, then Render → New → Blueprint and pick `render.yaml`. It defines the
web service, the build/start commands, `healthCheckPath: /health` and every non-secret variable; the
secrets (`DATABASE_URL`, `DATABASE_AUTH_TOKEN`) are prompted for once and `INTERNAL_API_TOKEN` is
generated.

**Manually** instead: New → Web Service → the repo, then

| Setting           | Value                                                  |
| ----------------- | ------------------------------------------------------ |
| Runtime           | Node (100 MB free tier is enough for the default caps) |
| Build command     | `npm ci && npm run build`                              |
| Start command     | `npm run worker:start`                                 |
| Health check path | `/health`                                              |
| Instance type     | Starter                                                |

Environment: `ENVIRONMENT=production`, `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `INTERNAL_API_TOKEN`
(generate one with `npm run token --workspace @proxypulse/worker`), plus whatever differs from the
defaults in `.env.example` (cadence, caps, `CR_*`).

Notes that matter in practice:

- **Run exactly one instance.** The scheduler is the pool writer; it is single-flight inside a process
  but not across replicas (the queue does not coordinate cycle starts). Two replicas mean double the
  requests to every source. Scale by raising `VALIDATION_CONCURRENCY`, not by adding instances.
- `PORT` is provided by Render and honoured (`HOST=0.0.0.0` default) — the health check needs the same
  port as the internal API.
- Render sends `SIGTERM` before a restart; the worker stops the scheduler, lets an in-flight cycle
  finish (25 s grace), closes the queue and the HTTP server, then exits. Long cycles are therefore not
  truncated mid-write, and a cycle interrupted anyway is recovered on the next boot.
- Never set `ALLOW_PRIVATE_ENDPOINTS=1` in production: it is the loopback escape hatch used by the demo
  and the tests.
- The service URL (`https://proxypulse-worker.onrender.com`) becomes the gateway's `RENDER_ORIGIN`.
  Because it is publicly routable, its only unprotected routes are `/health` and `/ready`.

Smoke test after the first deploy:

```bash
curl -s https://proxypulse-worker.onrender.com/health | jq
curl -s -X POST -H "authorization: Bearer $INTERNAL_API_TOKEN" \
     'https://proxypulse-worker.onrender.com/internal/cycle/run?wait=1' | jq
curl -s -H "authorization: Bearer $INTERNAL_API_TOKEN" \
     'https://proxypulse-worker.onrender.com/internal/stats?errors=1' | jq '.data | {pool_size, active, by_protocol}'
```

## 3. Cloudflare Worker (public API gateway)

For local iteration, `wrangler dev` reads `api/.dev.vars` (git-ignored, like `.env`):

```ini
RENDER_ORIGIN=http://127.0.0.1:8080
INTERNAL_API_TOKEN=<the value in your .env>
API_PUBLIC_KEYS=pp_dev_local_key_change_me
ENVIRONMENT=development
```

```bash
cd api
npx wrangler whoami                                # or: npx wrangler login

# 1) secrets (never put these in wrangler.jsonc)
npx wrangler secret put RENDER_ORIGIN              # https://proxypulse-worker.onrender.com
npx wrangler secret put INTERNAL_API_TOKEN         # identical to the worker's value
npx wrangler secret put API_PUBLIC_KEYS            # comma separated reader keys

# 2) optional: exact rate limiting across edges. On Cloudflare's free plan SKIP this: KV's 1,000 writes
#    per day are consumed by the limiter otherwise, and the per-isolate fallback is a fine soft limit.
npx wrangler kv namespace create RATE_LIMIT_KV     # copy the returned id into api/wrangler.jsonc
#      "kv_namespaces": [{ "binding": "RATE_LIMIT_KV", "id": "<id>" }]

# 3) local check against a running worker, then deploy
npx wrangler dev --var RENDER_ORIGIN:http://127.0.0.1:8080 --var INTERNAL_API_TOKEN:unit_test_internal_token_0123456789
npx wrangler deploy

# 4) public domain (or use the free *.workers.dev route)
npx wrangler deployments list
```

Generate reader keys with anything high-entropy, e.g. `openssl rand -hex 24` prefixed with `pp_live_`.
Every key grants read access to the whole pool, so treat them like credentials: one per consumer,
rotate by adding the new key to `API_PUBLIC_KEYS`, waiting for the cache TTL, then removing the old one.

Verify:

```bash
curl -s https://api.<domain>/ | jq '.data | {endpoints, rate_limit, cache}'
curl -s -H "authorization: Bearer <key>" 'https://api.<domain>/pool?limit=2' | jq
curl -s -o /dev/null -w '%{http_code}\n' https://api.<domain>/pool            # 401
curl -s -H "authorization: Bearer <key>" 'https://api.<domain>/tpool' | jq '.data | {service, valid, last_check, next_check}'
```

Caching behaviour is observable: a second identical `/pool` call within 30 s returns
`x-proxypulse-cached: 1` and an `age` header. To force a fresh origin read outside production, append
`?bypass_cache=1`.

## 4. Optional: Cloudflare Queues as the job transport

The pipeline needs no queue service — `QUEUE_DRIVER=memory` runs everything in-process. Use Queues when
you want durable fan-out (or manual jobs to survive a restart).

```bash
npx wrangler queues create proxypulse-jobs
npx wrangler queues consumer http add proxypulse-jobs \
  --batch-size 50 --visibility-timeout-secs 60 --retry-delay-secs 30 --message-retries 2
npx wrangler queues consumer http list proxypulse-jobs
```

Then create an API token with **both** `Queues Read` and `Queues Write` (a pull consumer must be able to
write acknowledgments) and set on the worker:

```
QUEUE_DRIVER=cloudflare
CLOUDFLARE_ACCOUNT_ID=<account id>
CLOUDFLARE_QUEUE_ID=proxypulse-jobs
CLOUDFLARE_QUEUES_TOKEN=<api token>
QUEUE_BATCH_SIZE=50            # ≤ 100 (API maximum)
QUEUE_VISIBILITY_TIMEOUT_MS=60000
QUEUE_MAX_RETRIES=2
```

How the worker uses it (see `worker/src/queue/cloudflare-queue.ts`): it produces with
`POST /messages` (chunked at 100 per request), pulls with `POST /messages/pull`
(`{batch_size, visibility_timeout_ms}`) and finishes each batch with `POST /messages/ack`
(`{acks:[{lease_id}], retries:[{lease_id}]}`). A cycle produces its jobs and then drains them, so
consumption stays in lockstep with the refresh interval; outside a cycle, `POST /internal/jobs` is
drained immediately. Because the pull API short-polls, an idle service loop backs off for
`QUEUE_POLL_SECONDS` instead of hammering the REST endpoint. If any of the three `CLOUDFLARE_*`
variables is missing, startup fails with a clear error rather than silently running without durability.

The queue never carries credentials: messages are `{job_id, type, cycle_id, proxy_id}` only, which is why
it is safe to inspect them in the Cloudflare dashboard.

## 5. Rollback, monitoring, housekeeping

**Rollback.** Both services are stateless apart from the database; redeploy the previous build (Render
and `wrangler deploy` of the pinned commit). Never delete `proxies` rows to "fix" a bad pool — lower
`POOL_MIN_SCORE`/`CR_*` caps or quarantine the affected rows instead; the pool self-heals over the next
cycles because expired members age out (`POOL_TTL_MINUTES`) and failures quarantine
(`POOL_MAX_CONSECUTIVE_FAILURES`).

**Monitoring.** Point a scraper at `GET /internal/metrics` (`proxypulse_pool_size`,
`proxypulse_proxies{status=…}`, `proxypulse_cycles_total{result=…}`, `proxypulse_uptime_ms`), or poll
`GET /internal/stats` and alert on:

- `refresh.cycles_failed` increasing, or `refresh.last_cycle` older than ~2× the interval;
- `pool_size` collapsing toward 0 while `total_known` stays high (target or source trouble);
- `service_check.cooldown: true` for a long time (the service is throttling us — leave it alone);
- `service_check.robots.allowed: false` (a `robots.txt` change must stop the probes, by design);
- `database.latency_ms` climbing (Turso region / cold start).

Logs are one JSON object per line with a stable `event` field (`CYCLE_STARTED`,
`DISCOVERY_SOURCE_FAILED`, `VALIDATION_COMPLETED`, `SERVICE_CHECK_SKIPPED`, `POOL_UPDATED`,
`SSRF_BLOCKED`, `API_REQUEST`, …), so `grep`/Logtail queries are cheap. They never contain proxy
passwords, tokens or full authenticated URLs.

**Housekeeping.** Once a day the worker prunes history (`RETENTION_RESULT_DAYS`,
`RETENTION_DEAD_PROXY_DAYS`, `RETENTION_CYCLE_DAYS`); nothing else needs cron. For a manual pass use
`npm run db:prune`. Backups: `turso db create replica --from-db proxypulse` (or a snapshot of the
SQLite file) — the pool is rebuildable, but `first_seen`, counters and per-proxy history are what make
scores meaningful.

**Cost/behaviour guardrails** worth re-checking after any config change: validations per cycle
(`VALIDATION_MAX_PER_CYCLE`), service checks per cycle and per minute (`CR_MAX_CHECKS_PER_CYCLE`,
`CR_RATE_LIMIT_PER_MINUTE`), pool size (`POOL_MAX_ACTIVE`), and the per-source
`DISCOVERY_MAX_BYTES`/`maxEntries` caps. A Render instance that never finishes a cycle in 15 minutes is
a sign these are set too high, not a reason to overlap cycles (the scheduler will simply skip and log
`CYCLE_SKIPPED`).

## Pre-go-live checklist

- [ ] `npm run verify` green on the commit being deployed
- [ ] `npm run demo:local` green (proves the pipeline end to end without network)
- [ ] Turso reachable, migrations applied (`npm run db:status`)
- [ ] `INTERNAL_API_TOKEN` ≥ 16 chars, identical in both services, not in Git
- [ ] `ENVIRONMENT=production`, no `ALLOW_PRIVATE_ENDPOINTS`, `LOG_LEVEL=info`
- [ ] `config/sources.json` contains only sources whose terms permit automated fetching
- [ ] `CR_RESPECT_ROBOTS=1` (leave it on), `CR_RATE_LIMIT_PER_MINUTE` sane for your volume
- [ ] Gateway: `RENDER_ORIGIN` is an `https://` origin with no path; `API_PUBLIC_KEYS` non-empty
- [ ] Cron trigger enabled in `api/wrangler.jsonc` if the origin runs on Render's free plan
- [ ] KV namespace id filled in `api/wrangler.jsonc` only if you want exact rate limiting (skip on CF free)
- [ ] `GET /internal/metrics` scraped, and a `pool_size == 0` alert wired up
- [ ] Health check green in Render's dashboard, and `curl <gateway>/pool` returns entries
