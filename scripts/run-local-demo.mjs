#!/usr/bin/env node
/**
 * End-to-end local demo — no network access, no live proxy lists, no external services.
 *
 *   node scripts/run-local-demo.mjs            # self test: runs a real cycle and asserts the result
 *   node scripts/run-local-demo.mjs --serve     # leaves the worker + internal API running on :8080
 *   node scripts/run-local-demo.mjs --keep      # keeps the temp fixtures/db for inspection
 *
 * What it does:
 *   1. starts the mock target server and four mock proxies (http/socks5/socks4 forward, plus a broken one)
 *   2. writes a fixture proxy list containing good entries, malformed entries, duplicates and a
 *      blocked link-local address
 *   3. boots the *real* worker runtime against a temporary SQLite file
 *   4. runs one full cycle (discovery → policy filter → validation → service check → scoring → pool)
 *   5. calls the internal API over HTTP exactly like the Cloudflare gateway would
 *
 * It runs against the compiled output, so `npm run build` (or `npm run worker:dev`) must have
 * succeeded at least once.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPTS = join(ROOT, 'scripts');
const argv = process.argv.slice(2);
const serve = argv.includes('--serve');
const keep = argv.includes('--keep');

const TOKEN = 'demo_internal_token_do_not_reuse_1234567890';

const failures = [];
const notes = [];
const assert = (condition, label, detail = '') => {
  if (condition) {
    notes.push(`  ok   ${label}`);
  } else {
    failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const log = (...args) => process.stdout.write(`${args.join(' ')}\n`);

/** Spawns one of the mock servers and waits for its `LISTENING <port>` line. */
function startMock(file, args = []) {
  return new Promise((resolveStart, rejectStart) => {
    const proc = spawn(process.execPath, [join(SCRIPTS, file), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: ROOT,
    });
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGKILL');
        rejectStart(new Error(`${file} did not report a listening port (output: ${buffer})`));
      }
    }, 10_000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = /LISTENING (\d+)/.exec(buffer);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolveStart({ proc, port: Number(match[1]) });
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      buffer += chunk;
    });
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectStart(new Error(`${file} exited early with code ${code} (output: ${buffer})`));
      }
    });
  });
}

const waitForPort = async (port, timeoutMs = 4_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((done) => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.destroy();
        done();
      });
      socket.on('error', () => done());
      socket.setTimeout(250, () => {
        socket.destroy();
        done();
      });
    });
    const open = await new Promise((done) => {
      const probe = createConnection({ port, host: '127.0.0.1' }, () => {
        probe.destroy();
        done(true);
      });
      probe.on('error', () => done(false));
      probe.setTimeout(250, () => {
        probe.destroy();
        done(false);
      });
    });
    if (open) return true;
  }
  return false;
};

async function main() {
  const workerEntry = join(ROOT, 'worker', 'dist', 'runtime.js');
  if (!existsSync(workerEntry)) {
    log('worker/dist/runtime.js is missing — run `npm run build` first.');
    process.exit(1);
  }

  // local-file discovery sources are only allowed to read inside the working directory, so the
  // throwaway fixtures live in a git-ignored .demo-tmp folder rather than in /tmp.
  const scratch = join(ROOT, '.demo-tmp');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'run-'));
  const cleanup = [];

  try {
    // ---------------------------------------------------------------- mocks
    log('▶ starting mock services');
    const target = await startMock('mock-target-server.mjs');
    cleanup.push(() => target.proc.kill('SIGKILL'));
    const proxies = {
      http: await startMock('mock-proxy-server.mjs', ['--protocol', 'http', '--mode', 'forward']),
      socks5: await startMock('mock-proxy-server.mjs', [
        '--protocol',
        'socks5',
        '--mode',
        'forward',
      ]),
      socks4: await startMock('mock-proxy-server.mjs', [
        '--protocol',
        'socks4',
        '--mode',
        'forward',
      ]),
      broken: await startMock('mock-proxy-server.mjs', ['--protocol', 'http', '--mode', 'reject']),
      hanging: await startMock('mock-proxy-server.mjs', ['--protocol', 'http', '--mode', 'hang']),
      authed: await startMock('mock-proxy-server.mjs', [
        '--protocol',
        'http',
        '--mode',
        'forward',
        '--require-auth',
        'demo:secret',
      ]),
    };
    for (const [name, handle] of Object.entries(proxies)) {
      cleanup.push(() => handle.proc.kill('SIGKILL'));
      await waitForPort(handle.port);
      notes.push(`  ok   mock ${name} proxy on 127.0.0.1:${handle.port}`);
    }
    log(
      `  target 127.0.0.1:${target.port}, proxies ${Object.entries(proxies)
        .map(([k, v]) => `${k}:${v.port}`)
        .join(' ')}`,
    );

    // ------------------------------------------------------------ fixtures
    const fixture = [
      `http://127.0.0.1:${proxies.http.port}`,
      `socks5://127.0.0.1:${proxies.socks5.port}`,
      `socks4://127.0.0.1:${proxies.socks4.port}`,
      `http://demo:secret@127.0.0.1:${proxies.authed.port}`,
      `http://127.0.0.1:${proxies.broken.port}`,
      `http://127.0.0.1:${proxies.hanging.port}`,
      // duplicate + variant spellings of the same endpoint
      `HTTP://127.0.0.1:${proxies.http.port}`,
      `127.0.0.1:${proxies.http.port}`,
      // dead port on loopback (connect refused)
      'http://127.0.0.1:1',
      // must be rejected by the parser
      'not-a-proxy-at-all',
      '1.2.3',
      'http://',
      '256.300.1.1:8080',
      'http://127.0.0.1:99999',
      // must be blocked by network policy (link-local metadata range)
      'http://169.254.169.254:80',
      '# a comment line that should be skipped',
      '',
    ].join('\n');
    const fixturePath = join(dir, 'proxies.txt');
    writeFileSync(fixturePath, `${fixture}\n`);
    const sourcesPath = join(dir, 'sources.json');
    writeFileSync(
      sourcesPath,
      JSON.stringify(
        {
          sources: [
            {
              id: 'demo-fixtures',
              kind: 'local-file',
              enabled: true,
              path: fixturePath,
              trust: 0.9,
              note: 'offline demo fixtures (mock proxies on loopback)',
            },
          ],
        },
        null,
        2,
      ),
    );

    // -------------------------------------------------------------- worker
    log('▶ booting the worker runtime against a temp database');
    const { loadConfig } = await import('../worker/dist/config.js');
    const { createRuntime } = await import('../worker/dist/runtime.js');
    const env = {
      ...process.env,
      ENVIRONMENT: 'test',
      LOG_LEVEL: process.env.DEMO_LOG_LEVEL ?? 'warn',
      DATABASE_URL: `file:${join(dir, 'proxypulse.db')}`,
      INTERNAL_API_TOKEN: TOKEN,
      HOST: '127.0.0.1',
      RUN_CYCLE_ON_STARTUP: '0',
      REFRESH_INTERVAL_MINUTES: '15',
      PROXY_SOURCES_FILE: sourcesPath,
      DISCOVERY_CONCURRENCY: '2',
      DISCOVERY_RETRIES: '1',
      ALLOW_PRIVATE_ENDPOINTS: '1',
      VALIDATION_CONCURRENCY: '4',
      VALIDATION_TIMEOUT_MS: '2500',
      VALIDATION_CONNECT_TIMEOUT_MS: '1200',
      VALIDATION_RETRIES: '1',
      VALIDATION_BACKOFF_MS: '50',
      VALIDATION_CHECK_URL: `http://127.0.0.1:${target.port}/generate_204`,
      POOL_MIN_SCORE: '0',
      POOL_TTL_MINUTES: '90',
      POOL_MAX_ACTIVE: '500',
      POOL_MAX_NEW_PER_CYCLE: '50',
      POOL_REQUIRE_SERVICE_PASS: '0',
      CR_CHECK_ENABLED: '1',
      CR_CHECK_SCHEME: 'http',
      CR_CHECK_URL: `http://127.0.0.1:${target.port}/ok`,
      CR_ALLOWED_HOSTS: '127.0.0.1',
      CR_RESPECT_ROBOTS: '1',
      CR_TIMEOUT_MS: '2500',
      CR_RATE_LIMIT_PER_MINUTE: '60',
      CR_MAX_CHECKS_PER_CYCLE: '10',
      CR_MIN_REQUEST_SPACING_MS: '0',
      QUEUE_DRIVER: 'memory',
    };
    const config = loadConfig({ env, cwd: ROOT });
    const runtime = await createRuntime({ config, startHttp: true, version: 'demo', cwd: ROOT });
    const { port } = await runtime.listen(0, '127.0.0.1');
    cleanup.push(() => runtime.stop());
    const base = `http://127.0.0.1:${port}`;
    log(`  internal API on ${base}`);

    // --------------------------------------------------------------- cycle
    log('▶ running one refresh cycle');
    const report = await runtime.runCycle({ trigger: 'manual' });
    const d = report.discovery;
    const v = report.validation;
    const s = report.service;
    log(
      `  discovered ${d.discovered} · accepted ${d.accepted} · rejected ${d.rejected} · duplicates ${d.duplicates} · policy-blocked ${d.blocked_by_policy}`,
    );
    log(
      `  validated ${v.checked} · passed ${v.passed} · failed ${v.failed} · pool ${report.pool.size}`,
    );
    log(
      `  service checks ${s.checked} · passed ${s.passed} · blocked ${s.blocked} · skipped ${s.skipped}`,
    );

    assert(report.status === 'completed', 'cycle completed', String(report.error ?? ''));
    assert(d.accepted === 7, 'every endpoint-shaped line parsed', `accepted=${d.accepted}`);
    assert(d.duplicates >= 2, 'duplicate spellings collapsed', `duplicates=${d.duplicates}`);
    assert(d.rejected >= 4, 'malformed lines rejected', `rejected=${d.rejected}`);
    assert(
      d.blocked_by_policy >= 1,
      'link-local metadata address blocked',
      `blocked=${d.blocked_by_policy}`,
    );
    assert(v.checked >= 5, 'candidate proxies validated', `checked=${v.checked}`);
    assert(v.passed >= 3, 'forwarding proxies reached the target', `passed=${v.passed}`);
    assert(v.failed >= 2, 'broken proxies marked failed', `failed=${v.failed}`);
    assert(report.pool.size >= 3, 'pool holds the healthy proxies', `pool=${report.pool.size}`);
    assert(s.checked >= 1, 'service adapter probed at least one proxy', `checked=${s.checked}`);
    assert(s.passed >= 1, 'service adapter accepted a forwarding proxy', `passed=${s.passed}`);

    const pool = await runtime.proxies.readPool({
      limit: 50,
      offset: 0,
      protocol: null,
      minScore: 0,
      maxLatencyMs: null,
      country: null,
      service: 'off',
      ttlMinutes: 90,
      nowIso: new Date().toISOString(),
    });
    assert(
      pool.entries.length >= 3,
      'pool readable straight from the database',
      `rows=${pool.entries.length}`,
    );
    assert(
      pool.entries.every((entry) => !('password' in entry) && !('username' in entry)),
      'pool rows carry no credentials',
    );
    const protocols = new Set(pool.entries.map((entry) => entry.protocol));
    assert(
      protocols.has('http') && protocols.has('socks5'),
      'both http and socks5 made it into the pool',
      [...protocols].join(','),
    );

    const statuses = await runtime.proxies.countByStatus();
    assert(
      statuses.active === report.pool.size,
      'only healthy proxies are active',
      JSON.stringify(statuses),
    );
    assert(
      statuses.new + statuses.quarantined + statuses.dead >= 3,
      'broken proxies stay out of the pool instead of being deleted',
      JSON.stringify(statuses),
    );
    notes.push(`  info statuses ${JSON.stringify(statuses)}`);

    // ----------------------------------------------------------------- API
    log('▶ calling the internal API the way the Cloudflare gateway will');
    const auth = { authorization: `Bearer ${TOKEN}` };
    const health = await fetch(`${base}/health`);
    const healthBody = await health.json();
    assert(health.status === 200 && healthBody.ok === true, 'GET /health is public and ok');
    assert(healthBody.meta?.request_id, 'health response carries a request id');
    assert(healthBody.meta?.timestamp, 'health response carries a timestamp');

    const unauth = await fetch(`${base}/internal/pool`);
    assert(
      unauth.status === 401,
      'GET /internal/pool without a token is rejected',
      String(unauth.status),
    );
    const badToken = await fetch(`${base}/internal/pool`, {
      headers: { authorization: 'Bearer nope' },
    });
    assert(
      badToken.status === 401,
      'GET /internal/pool with a wrong token is rejected',
      String(badToken.status),
    );

    const poolRes = await fetch(`${base}/internal/pool?limit=5&min_score=0&service=off`, {
      headers: auth,
    });
    const poolBody = await poolRes.json();
    assert(
      poolRes.status === 200 && poolBody.ok === true,
      'GET /internal/pool returns the envelope',
    );
    assert(
      Array.isArray(poolBody.data?.proxies) && poolBody.data.proxies.length >= 3,
      'pool payload has entries',
    );
    assert(
      poolBody.data?.proxies.every((entry) => entry.password === undefined),
      'pool payload has no passwords',
    );
    assert(typeof poolBody.meta?.pool_size === 'number', 'meta.pool_size present');
    assert(poolBody.meta?.service === 'crunchyroll', 'meta.service present');

    const badFilter = await fetch(`${base}/internal/pool?protocol=ftp`, { headers: auth });
    assert(badFilter.status === 400, 'unknown protocol filter rejected', String(badFilter.status));

    const randomRes = await fetch(`${base}/internal/random?service=off`, { headers: auth });
    const randomBody = await randomRes.json();
    assert(
      randomRes.status === 200 && randomBody.data?.proxy?.host,
      'GET /internal/random returns a proxy',
    );
    assert('score' in (randomBody.data?.proxy ?? {}), 'random proxy exposes a score');

    const statsRes = await fetch(`${base}/internal/stats`, { headers: auth });
    const statsBody = await statsRes.json();
    assert(
      statsRes.status === 200 && typeof statsBody.data?.pool_size === 'number',
      'GET /internal/stats reports pool size',
    );
    assert(statsBody.data?.refresh?.interval_minutes === 15, 'stats expose the 15 minute cadence');

    const tpoolRes = await fetch(`${base}/internal/tpool`, { headers: auth });
    const tpoolBody = await tpoolRes.json();
    assert(tpoolRes.status === 200, 'GET /internal/tpool returns 200');
    assert(tpoolBody.data?.service === 'crunchyroll', 'tpool names the service');
    assert(typeof tpoolBody.data?.valid === 'number', 'tpool reports a valid count');
    assert(
      tpoolBody.data?.last_check !== undefined && tpoolBody.data?.next_check !== undefined,
      'tpool reports last/next check',
    );

    const cyclesRes = await fetch(`${base}/internal/cycles?limit=5`, { headers: auth });
    const cyclesBody = await cyclesRes.json();
    assert(
      Array.isArray(cyclesBody.data?.cycles) && cyclesBody.data.cycles.length >= 1,
      'cycle history persisted',
    );
    const wrongMethod = await fetch(`${base}/internal/pool`, { method: 'POST', headers: auth });
    assert(
      wrongMethod.status === 405,
      'POST on a GET route returns 405',
      String(wrongMethod.status),
    );
    const missing = await fetch(`${base}/internal/nope`, { headers: auth });
    assert(missing.status === 404, 'unknown internal route returns 404');

    // A cycle is idempotent: running a second time must not wipe the pool.
    const second = await runtime.runCycle({ trigger: 'manual' });
    assert(second.status === 'completed', 'second cycle completed');
    assert(
      second.pool.size >= pool.entries.length,
      'pool is rolling, not rebuilt from scratch',
      `${second.pool.size} < ${pool.entries.length}`,
    );
    const cycles = await runtime.cycles.list(10);
    assert(cycles.length >= 2, 'both cycles recorded', String(cycles.length));

    if (serve) {
      log(`\n✅ demo up. Worker internal API: ${base}`);
      log(`   curl -H "authorization: Bearer ${TOKEN}" ${base}/internal/pool?limit=3`);
      log('   Ctrl-C to stop.');
      await new Promise((done) => {
        process.on('SIGINT', done);
        process.on('SIGTERM', done);
      });
      return;
    }

    await runtime.stop();

    log('\n' + notes.join('\n'));
    if (failures.length > 0) {
      log(`\n${failures.length} assertion(s) failed:`);
      log(failures.join('\n'));
      log(`\ntemp fixtures: ${dir}`);
      process.exitCode = 1;
    } else {
      log(
        `\n✅ demo self test passed (${notes.filter((line) => line.startsWith('  ok')).length} checks)`,
      );
    }
    process.exit(failures.length > 0 ? 1 : 0);
  } finally {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch {
        /* ignore shutdown races */
      }
    }
    if (!keep) rmSync(dir, { recursive: true, force: true });
    else if (existsSync(dir)) log(`temp fixtures kept at ${dir}`);
  }
}

main().catch((error) => {
  log(`demo failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  log('\n' + notes.join('\n'));
  if (failures.length > 0) log(failures.join('\n'));
  process.exit(1);
});
