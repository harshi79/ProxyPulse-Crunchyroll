# Development guide

## Prerequisites

- **Node.js ≥ 22** (`node --version`) — the worker uses `node:` built-ins only, plus `AbortSignal.timeout`
  and `fetch`. `wrangler` also requires Node 22+.
- npm ≥ 10 (workspaces). No global tooling, no Docker, no database server: SQLite in a file (or
  `:memory:`) is enough for everything except a production deploy.

```bash
npm install          # installs all five workspaces from the lockfile
npm run build        # shared → db → services/crunchyroll → worker (tsc -p per workspace)
npm run verify       # typecheck (incl. tests) + eslint + vitest
```

`npm run build` is required before `worker:dev`, `worker:start`, `pipeline:once`, `demo:local` and
`db:migrate`, because those scripts execute `dist/` output. `npm test` needs no build: vitest aliases the
workspace specifiers to their `src` entrypoints (`vitest.config.ts`) and `tsconfig.test.json` uses
`moduleResolution: Bundler` so tests can import sources without extensions.

## Scripts

| Command                                         | What it does                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run build`                                 | Compile every workspace (`--if-present`, so the api Worker is skipped: wrangler compiles it) |
| `npm run typecheck`                             | `tsc --noEmit` per workspace + `tsconfig.test.json` for the tests                            |
| `npm run lint` / `npm run lint:fix`             | ESLint (flat config, `typescript-eslint` type-aware rules off for speed)                     |
| `npm run format` / `format:check`               | Prettier over the whole repo                                                                 |
| `npm test` / `npm run test:watch`               | vitest (13 suites, all offline)                                                              |
| `npm run verify`                                | typecheck + lint + test — what CI runs                                                       |
| `npm run demo:local`                            | end-to-end offline demo + self-assertions (see below)                                        |
| `npm run worker:dev`                            | build, then run the worker with `--env-file-if-exists=../.env`                               |
| `npm run worker:start`                          | run the built worker (what Render runs)                                                      |
| `npm run pipeline:once`                         | one cycle, print the `CycleReport` JSON, exit non-zero on failure                            |
| `npm run db:migrate` / `db:status` / `db:prune` | SQL migrations, schema + row counts + latest cycle, history pruning                          |
| `npm run api:dev` / `api:deploy`                | `wrangler dev` / `wrangler deploy` for the Cloudflare gateway                                |
| `npm run token --workspace @proxypulse/worker`  | print a strong `INTERNAL_API_TOKEN`                                                          |
| `npm run pipeline:normalize -- --file list.txt` | run the parser over an arbitrary proxy list (no network)                                     |
| `npm run clean`                                 | remove all `dist/`, `coverage/`, caches                                                      |

## The offline demo

```bash
npm run demo:local            # self-test: asserts 47 checks and exits non-zero on failure
npm run demo:local -- --serve # leaves the worker + internal API running on :8080 to poke at
npm run demo:local -- --keep  # keeps .demo-tmp/run-* (fixtures + sqlite file) for inspection
```

`scripts/run-local-demo.mjs` starts `scripts/mock-target-server.mjs` and six
`scripts/mock-proxy-server.mjs` instances (http/socks5/socks4 forwarding, one requiring
`Proxy-Authorization`, one that answers 502, one that hangs), writes a fixture list that also contains
duplicate spellings, malformed lines and a link-local address, boots the **real** runtime
(`worker/src/runtime.ts`) against a temporary `file:` database, runs one full cycle, then exercises the
internal API over HTTP. Everything is loopback; nothing reaches the internet.

Mock server knobs (used by the tests):

```
mock-target-server.mjs  /generate_204 /ok /echo /robots.txt /challenge /limited /slow?ms= /big?kb= /status/<code>
mock-proxy-server.mjs   --protocol http|https|socks4|socks5 --mode forward|reject|hang|deny-connect|slow
                        --require-auth user:pass  --delay ms  --egress-file path  --port 0
```

Both print `LISTENING <port>`; `tests/helpers/servers.ts` spawns them and waits for that line.

## Repository conventions

- **ESM only.** Every package is `"type": "module"`; no `require`.
- **Relative imports inside `*/src` must carry the `.js` extension** (`import { x } from './y.js'`) —
  that is what NodeNext resolution and `tsc` emit require. TypeScript resolves `.js` → `.js`+`.d.ts` in
  the built output, and the `.ts` source is found through the emitted map. Writing `./y.ts` instead
  fails with `TS5097` (except for `import type`, which the compiler erases). Test files are the one
  exception: they are extensionless because vitest resolves them through Vite.
- **No new runtime dependencies in `shared/`.** It must stay importable from a Cloudflare Worker, which
  rules out `node:http`, `fs`, and any HTTP client. The proxy client is written directly on `node:net`
  and `node:tls` in `worker/src/net/` for exactly that reason.
- **Strict TypeScript everywhere**: `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
  `noUnusedLocals`/`noUnusedParameters`, `isolatedModules`. `import type` is mandatory for type-only
  imports (enforced by `consistent-type-imports`).
- **Never log or enqueue a secret.** Use `formatProxyRedacted()`/`redactText()`; queue payloads are
  identifiers only; `notes` columns hold machine codes (`low_score:12`, `failures:3`), not free text.
- **Fail closed.** Unknown enum values, unparsable payloads and unreachable policy checks are rejections,
  not warnings. Anything that could dial an address must go through `isProxyEndpointAllowed` (literal)
  and `createSafeLookup` (post-DNS).

## Working with the database

```bash
export DATABASE_URL=file:./data/proxypulse.db
npm run db:migrate     # applies db/migrations/*.sql in filename order, records a checksum
npm run db:status      # tables, row counts per status, last cycle
npm run db:prune       # RETENTION_DAYS=7 by default
```

Migrations are append-only SQL files with a checksum in `_schema_migrations`; a changed applied file is
an error rather than a silent re-run. `db/src/client.ts` splits files into single statements because the
Turso HTTP transport accepts one statement per request, and `batch()` is used where atomicity matters.
For tests, `createDb({ url: ':memory:' })` + `applyMigrations(...)` gives an isolated database in a few
milliseconds — every repository test does exactly that.

To explore the schema by hand: `sqlite3 data/proxypulse.db 'select status, count(*) from proxies group by 1'`
(local files only; production lives in Turso).

## Adding things

**A discovery source.** Add an entry to `config/sources.json` (see `config/sources.example.json`). Only
`http-list`, `json-endpoint` and `local-file` exist today; a genuinely different provider shape means a
new class in `worker/src/discovery/providers.ts` extending `BaseProvider` and returning
`{ proxies, rejected, duplicates, fetched_lines, bytes, status, note }` — then wire it in
`createProviders` and cover it in `tests/discovery.test.ts`. Set `trust` honestly: it feeds the quality
factor, so a flaky source should score low rather than be deleted. `respectRobots` (default `true`) is
there for inventories you host yourself — leave it on for anything else, because a source that says no
is answered with one request per cycle, not a retry loop.

**A service adapter.** Create `services/<name>/{types,rules,scorer,checker,index}.ts` mirroring
`services/crunchyroll`: `check(endpoint, {proxy_id, cycle_id})` returning
`{verdict: passed|failed|blocked|skipped, status, http_status, latency_ms, reason, details, robots}` and
never throwing, plus `statusForVerdict`/`serviceScore`/`shouldCheckService`. The pipeline needs only
those; `worker/src/runtime.ts` is where the adapter is constructed and given its own allow-listed
requester. Keep the politeness constraints (rate limit, budget, spacing, robots, breaker) — they are the
reason the checks are defensible.

**A validation outcome that changes pool state** belongs in `PoolManager.planValidation`, never in the
checker: the checker classifies, the pool decides, the repository persists. That separation is what
makes the state machine testable (see `tests/pool.test.ts`).

## Tests

| Suite                   | Covers                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `normalize.test.ts`     | entry parsing, protocol detection, IPv6 brackets, credential handling, dedupe keys, list-level skip/reject accounting |
| `scoring.test.ts`       | every score factor, `combineScores`, quarantine/expiry/eligibility                                                    |
| `db-operations.test.ts` | migrations, upsert/dedupe, queue selection, persistence, pool reads, cycles, meta, pruning                            |
| `proxy-client.test.ts`  | four protocols, tunnels vs absolute-form, auth, timeouts, response caps, failure classification                       |
| `validation.test.ts`    | reachable/unreachable, retry policy, attempt counts, egress echo, bounded concurrency, never-throws contract          |
| `ssrf.test.ts`          | address classes, metadata endpoints, non-canonical IP literals, url policy, DNS rebinding, requester refusals         |
| `pool.test.ts`          | status transitions, service scoring effects, expire/quarantine/cap/claims, `readPool` filters and safety              |
| `discovery.test.ts`     | providers (text/json/file), caps, rejects, retries, per-source outcomes, source config validation                     |
| `queue.test.ts`         | payload validation, ordering, capacity, retries, `maxJobs`, Cloudflare produce/pull/ack protocol                      |
| `crunchyroll.test.ts`   | verdict rules, robots fail-closed, cooldown, breaker, budget, header hygiene, allow-list enforcement                  |
| `worker-http.test.ts`   | internal API: auth, 404/405/413/400, envelope, views over an empty pool, cycle trigger, job intake                    |
| `api-gateway.test.ts`   | gateway: auth, filters, rate limit, caching + stale-on-error, upstream mapping, timeout handling                      |
| `pipeline.test.ts`      | one real cycle end to end, then rolling behaviour, quarantine growth, single-proxy job path                           |

All of them are deterministic and offline. `npm test` runs the lot in ~11 s. Useful while iterating:

```bash
npx vitest run tests/pool.test.ts
npx vitest run -t 'rolling'
npm run test:watch
```

## Style

Prettier owns formatting (`printWidth: 100`, single quotes, trailing commas, LF); ESLint owns correctness
(no `any`, no `console` outside the logger sink and the scripts, `eqeqeq`, `prefer-const`,
`no-useless-assignment`, `preserve-caught-error` — so wrapped errors must carry `{ cause }`). Run
`npm run format` before committing; CI enforces both.

Comment the _why_ at module top (`/** … */` in every source file does this today) and keep inline
comments to the non-obvious: retry policies, fail-closed decisions, protocol quirks.
