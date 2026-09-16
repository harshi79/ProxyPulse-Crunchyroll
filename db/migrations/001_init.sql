-- ProxyPulse initial schema.
-- Applied by `npm run db:migrate` (idempotent per file, tracked in _schema_migrations).

-- ---------------------------------------------------------------------------
-- proxies: the single source of truth for everything ProxyPulse knows
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proxies (
  id                  INTEGER PRIMARY KEY,
  -- protocol|host|port|username fingerprint, hashed so credentials never become index keys
  dedupe_key          TEXT    NOT NULL UNIQUE,
  host                TEXT    NOT NULL,
  port                INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  protocol            TEXT    NOT NULL CHECK (protocol IN ('http', 'https', 'socks4', 'socks5')),
  -- Only populated for authenticated (private/seed) sources. Never exposed by the public API.
  username            TEXT,
  password            TEXT,
  source              TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new', 'pending', 'active', 'quarantined', 'dead')),
  validation_status   TEXT    NOT NULL DEFAULT 'unchecked'
                      CHECK (validation_status IN ('unchecked', 'passed', 'failed')),
  service_status      TEXT    NOT NULL DEFAULT 'untested'
                      CHECK (service_status IN ('untested', 'passed', 'failed', 'blocked', 'skipped')),
  score               REAL    NOT NULL DEFAULT 0,
  latency_ms          INTEGER,
  service_latency_ms  INTEGER,
  service_checked_at  TEXT,
  service_fail_reason TEXT,
  last_error_code     TEXT,
  country             TEXT,
  anonymity           TEXT    NOT NULL DEFAULT 'unknown'
                      CHECK (anonymity IN ('elite', 'anonymous', 'transparent', 'unknown')),
  first_seen          TEXT    NOT NULL,
  last_seen           TEXT    NOT NULL,
  first_cycle_id      TEXT,
  last_cycle_id       TEXT,
  last_checked_at     TEXT,
  last_passed_at      TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  check_count         INTEGER NOT NULL DEFAULT 0,
  pass_count          INTEGER NOT NULL DEFAULT 0,
  notes               TEXT
);

-- Pool reads are ordered/filtered by status + score + freshness.
CREATE INDEX IF NOT EXISTS idx_proxies_pool          ON proxies (status, score DESC, last_passed_at DESC);
CREATE INDEX IF NOT EXISTS idx_proxies_service_pool  ON proxies (service_status, status, score DESC);
CREATE INDEX IF NOT EXISTS idx_proxies_host_port     ON proxies (host, port);
CREATE INDEX IF NOT EXISTS idx_proxies_last_checked  ON proxies (last_checked_at);
CREATE INDEX IF NOT EXISTS idx_proxies_source_status ON proxies (source, status);
CREATE INDEX IF NOT EXISTS idx_proxies_recheck       ON proxies (status, last_checked_at);

-- ---------------------------------------------------------------------------
-- validation_results: one row per connectivity check (append only, pruned by retention)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS validation_results (
  id            INTEGER PRIMARY KEY,
  proxy_id      INTEGER NOT NULL REFERENCES proxies (id) ON DELETE CASCADE,
  cycle_id      TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  reachable     INTEGER NOT NULL CHECK (reachable IN (0, 1)),
  latency_ms    INTEGER,
  protocol      TEXT    NOT NULL,
  transport     TEXT,
  http_status   INTEGER,
  error_code    TEXT,
  error_message TEXT,
  attempts      INTEGER NOT NULL DEFAULT 1,
  duration_ms   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_validation_proxy ON validation_results (proxy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_validation_cycle ON validation_results (cycle_id);
CREATE INDEX IF NOT EXISTS idx_validation_created ON validation_results (created_at);

-- ---------------------------------------------------------------------------
-- service_results: one row per service compatibility check
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_results (
  id         INTEGER PRIMARY KEY,
  proxy_id   INTEGER NOT NULL REFERENCES proxies (id) ON DELETE CASCADE,
  cycle_id   TEXT    NOT NULL,
  service    TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  passed     INTEGER NOT NULL CHECK (passed IN (0, 1)),
  status     TEXT    NOT NULL CHECK (status IN ('passed', 'failed', 'blocked', 'skipped')),
  http_status INTEGER,
  latency_ms  INTEGER,
  reason      TEXT,
  -- JSON text with a small, allow-listed summary (never headers that carry credentials)
  details     TEXT
);

CREATE INDEX IF NOT EXISTS idx_service_proxy   ON service_results (proxy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_cycle   ON service_results (cycle_id, passed);
CREATE INDEX IF NOT EXISTS idx_service_summary ON service_results (service, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- refresh_cycles: one row per 15 minute cycle
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_cycles (
  cycle_id             TEXT PRIMARY KEY,
  status               TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at           TEXT NOT NULL,
  finished_at          TEXT,
  candidates_discovered INTEGER NOT NULL DEFAULT 0,
  candidates_new       INTEGER NOT NULL DEFAULT 0,
  candidates_checked   INTEGER NOT NULL DEFAULT 0,
  candidates_passed    INTEGER NOT NULL DEFAULT 0,
  candidates_failed    INTEGER NOT NULL DEFAULT 0,
  service_checked      INTEGER NOT NULL DEFAULT 0,
  service_passed       INTEGER NOT NULL DEFAULT 0,
  pool_size            INTEGER NOT NULL DEFAULT 0,
  pool_added           INTEGER NOT NULL DEFAULT 0,
  pool_quarantined     INTEGER NOT NULL DEFAULT 0,
  pool_expired         INTEGER NOT NULL DEFAULT 0,
  duration_ms          INTEGER,
  error                TEXT
);

CREATE INDEX IF NOT EXISTS idx_cycles_started   ON refresh_cycles (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cycles_completed ON refresh_cycles (status, finished_at DESC);

-- ---------------------------------------------------------------------------
-- meta: tiny key/value store for cycle scheduling and cached aggregates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
