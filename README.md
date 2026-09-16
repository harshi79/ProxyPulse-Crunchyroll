# ProxyPulse

**Proxy discovery → normalisation → deduplication → connectivity validation → authorised
Crunchyroll compatibility check → scoring → rolling pool → public API.**

ProxyPulse maintains a live pool of public proxy endpoints that are _known to forward traffic_ and
_known to complete a normal HTTPS request against a service we are allowed to probe_. The pool is
served through a small public HTTP API backed by Turso (libSQL), refreshed on a 15 minute rolling
cycle by a background worker.

> **What this project deliberately is not.** It is not a geo-unblocking tool, not a VPN, and not a
> bot-protection bypass. The Crunchyroll step is a _compatibility probe_: it fetches one public,
> unauthenticated endpoint (`robots.txt` by default) through each proxy and records whether an ordinary
> request succeeded. It never attempts to evade rate limits, CAPTCHAs, bot challenges, geoblocks or
> authentication, never touches login or DRM endpoints, and honours `robots.txt`. Only publicly
> available proxy lists that permit automated collection are fetched — each one behind its own
> `robots.txt` check, at most one request per source per refresh cycle.

## How it works

```
   public list sources                     Turso / libSQL
   (opt-in, permitted)                          ▲        │
        │                                       │        ▼
        ▼  fetch (bounded, retried)        ┌────┴─────────────┐     GET /pool /random
   ┌──────────┐  normalize + dedupe +      │   proxies table   │     /stats /tpool
   │ discovery│  policy filter (SSRF) ────▶│  validation_results│        │
   └──────────┘                            │  service_results    │        ▼
        │                                  │  refresh_cycles     │   ┌──────────────┐
        ▼  VALIDATE jobs (queue)           └────────▲────────────┘   │  Cloudflare  │
   ┌───────────────┐   per-proxy HTTP/HTTPS/         │                │   Worker     │
   │  validation   │──SOCKS4/SOCKS5 request ─────────┘                │  (edge: auth,│
   │   engine      │  reachable? latency? attempts?   scoring +       │  cache, rate  │
   └───────────────┘  egress address?                 pool policy      │  limit)       │
        │                                                       ▲      └──────────────┘
        ▼  SERVICE_CHECK jobs (rate limited, budgeted)          │
   ┌──────────────────────┐                                     │
   │ Crunchyroll adapter  │─ verdict ── combineScores ───────────┘
   └──────────────────────┘
```

Each refresh cycle: discover → filter → upsert candidates → validate a bounded batch → run a bounded
number of service checks on the best candidates → recompute scores → expire/quarantine/cap the pool →
write cycle statistics. Healthy members are **not** deleted and re-added; they are re-checked on their
own schedule, so a source outage or a slow target never empties the pool.

## Quickstart

```bash
npm install
npm run build
cp .env.example .env            # then set DATABASE_URL and INTERNAL_API_TOKEN
npm run db:migrate
npm run worker:dev              # pipeline + scheduler + internal API on :8080
```

No credentials, no network, no Turso? Prove the whole pipeline locally:

```bash
npm run demo:local              # ~6s: mock proxies + fixtures + one-shot cycle + API assertions
```

The demo starts the local mock target and mock proxies (http/socks4/socks5, plus a broken and a hanging
one), writes a fixture list containing valid, duplicate and malformed entries, runs a **real** cycle
against a temporary SQLite database, then calls the internal API exactly like the Cloudflare gateway
does and asserts 47 checks (statuses, scores, pool contents, auth, filters, envelope, rolling behaviour).

## Public API

| Endpoint      | Purpose                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /pool`   | paged, filtered pool view (`limit`, `offset`, `protocol`, `min_score`, `max_latency_ms`, `country`, `service`) |
| `GET /random` | one score-weighted proxy from the pool (never cached)                                                          |
| `GET /stats`  | pool statistics, latest cycle, worker and service-check status                                                 |
| `GET /tpool`  | `{service, valid, last_check, next_check}` — summary of the latest test cycle                                  |
| `GET /health` | liveness of the pool origin                                                                                    |

Every response carries the same envelope — `{ok, data, meta}` with `meta.request_id`,
`meta.timestamp`, `meta.pool_size`, `meta.last_update`, `meta.service` — and **never** contains proxy
credentials. Full reference: [docs/API.md](docs/API.md).

```bash
curl -H "authorization: Bearer $API_KEY" "https://api.example.com/pool?limit=5&protocol=socks5&min_score=70"
```

## Repository layout

| Path                    | Contents                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `shared/`               | runtime-agnostic domain logic: parsing, normalisation, dedup, IP/URL policy, scoring, envelope, logging, redaction                |
| `db/`                   | libSQL/Turso client, SQL migrations, repositories (no ORM)                                                                        |
| `services/crunchyroll/` | the authorised service adapter: checker, rules, scorer                                                                            |
| `worker/`               | discovery providers, validation engine, pool manager, queues, pipeline, scheduler, internal HTTP API                              |
| `api/`                  | Cloudflare Worker: public gateway (auth, rate limit, cache, envelope)                                                             |
| `scripts/`              | mock proxy/target servers and the offline demo                                                                                    |
| `tests/`                | 13 vitest suites, 241 tests — fixtures + loopback mocks only, no live internet                                                    |
| `docs/`                 | [ARCHITECTURE](docs/ARCHITECTURE.md) · [API](docs/API.md) · [DEVELOPMENT](docs/DEVELOPMENT.md) · [DEPLOYMENT](docs/DEPLOYMENT.md) |

## Configuration

Everything is environment driven (see [`.env.example`](.env.example)) and every knob has a safe default:
`REFRESH_INTERVAL_MINUTES=15`, `VALIDATION_CONCURRENCY=24`, `VALIDATION_TIMEOUT_MS=8000`,
`POOL_MIN_SCORE=25`, `POOL_TTL_MINUTES=90`, `CR_RATE_LIMIT_PER_MINUTE=30`, `CR_MAX_CHECKS_PER_CYCLE=250`.

Discovery sources live in [`config/sources.json`](config/sources.json) (opt-in; see
[`config/sources.example.json`](config/sources.example.json) for the shape and permitted public
providers).

## Checks

```bash
npm run typecheck     # tsc across all workspaces + the test project
npm run lint          # eslint (flat config)
npm test              # vitest
npm run verify        # all three
```

## Operations

Deployment is two pieces: a Render web service (worker + internal API, health check on `/health`) and a
Cloudflare Worker (public gateway) — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). All three backing
services have a free tier and the shipped config fits inside it: Render `plan: free`, Cloudflare Workers
free (with a 5-minute cron keep-alive instead of KV), and a free Turso database — details in
[docs/DEPLOYMENT.md#running-on-free-tiers](docs/DEPLOYMENT.md#running-on-free-tiers-it-works-and-this-is-the-intended-hobby-setup). Metrics for scraping
are on `GET /internal/metrics`, cycle history on `GET /internal/cycles`.

## Licence

MIT — see [LICENSE](LICENSE).
