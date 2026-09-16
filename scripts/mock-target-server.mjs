#!/usr/bin/env node
/**
 * Local HTTP target used by tests and the offline demo, standing in for whatever endpoint
 * VALIDATION_CHECK_URL points at. Prints `LISTENING <port>` once ready.
 *
 * Routes:
 *   /generate_204        204, no body (connectivity probe default)
 *   /ok                  200 JSON describing the request (path, ua, peer address)
 *   /robots.txt          200 with a robots.txt that allows everything
 *   /echo                200 text/plain with the peer address (egress echo checks)
 *   /status/<code>       responds with that status
 *   /slow?ms=<n>         delays the response
 *   /big?kb=<n>          streams n KiB
 *   /challenge           403 with a bot-challenge style body (must never look like a pass)
 *   /limited             429 with Retry-After: 3
 */

import http from 'node:http';

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const port = Number(readArg('port', '0'));

const send = (res, status, body, headers = {}) => {
  const payload = body === null ? '' : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload.length === 0 ? undefined : payload);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const peer = `${req.socket.remoteAddress}`;
  switch (true) {
    case url.pathname === '/generate_204':
      return send(res, 204, null, { 'x-peer': peer });
    case url.pathname === '/ok':
      return send(
        res,
        200,
        JSON.stringify({
          ok: true,
          path: url.pathname,
          method: req.method,
          user_agent: req.headers['user-agent'] ?? null,
          peer,
          x_forwarded_for: req.headers['x-forwarded-for'] ?? null,
        }),
        { 'x-peer': peer },
      );
    case url.pathname === '/echo':
      return send(res, 200, peer, { 'content-type': 'text/plain; charset=utf-8', 'x-peer': peer });
    case url.pathname === '/robots.txt':
      return send(
        res,
        200,
        'User-agent: *\nAllow: /\n# mock robots for ProxyPulse local testing\nSitemap: /sitemap.xml\n',
        { 'content-type': 'text/plain; charset=utf-8' },
      );
    case url.pathname === '/challenge':
      return send(
        res,
        403,
        '<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>',
        {
          'content-type': 'text/html; charset=utf-8',
          'cf-mitigated': 'challenge',
        },
      );
    case url.pathname === '/limited':
      return send(res, 429, JSON.stringify({ error: 'too many requests' }), { 'retry-after': '3' });
    case url.pathname === '/slow': {
      const ms = Number(url.searchParams.get('ms') ?? '1000');
      setTimeout(
        () => send(res, 200, JSON.stringify({ ok: true, delayed_ms: ms })),
        Math.max(0, ms),
      );
      return undefined;
    }
    case url.pathname === '/big': {
      const kb = Math.max(1, Number(url.searchParams.get('kb') ?? '64'));
      const chunk = Buffer.alloc(1024, 0x61);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      let sent = 0;
      const pump = () => {
        while (sent < kb) {
          sent += 1;
          if (!res.write(chunk) && sent < kb) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
      return undefined;
    }
    case /^\/status\/\d{3}$/.test(url.pathname): {
      const status = Number(url.pathname.split('/')[2]);
      return send(res, status, JSON.stringify({ status }));
    }
    default:
      return send(res, 404, JSON.stringify({ error: 'not_found', path: url.pathname }));
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
