#!/usr/bin/env node
/**
 * Local mock proxy server for tests and the offline demo. Supports the four protocols ProxyPulse
 * speaks and a few behaviour switches so we can exercise timeouts, refusals and authentication.
 *
 *   node scripts/mock-proxy-server.mjs --protocol http --port 0 --mode forward
 *
 * Prints `LISTENING <port> <protocol> <mode>` once ready (port 0 lets the OS pick one).
 *
 * Modes:
 *   forward         connect to the target and pipe bytes both ways (default)
 *   hang            accept the socket and never respond (timeout tests)
 *   reject          refuse every tunnel/request (502 / SOCKS failure reply)
 *   deny-connect    policy-style refusal (403 for CONNECT, SOCKS "not allowed")
 *   slow            forward, but delay the first response byte by --delay ms
 *
 * Options:
 *   --require-auth user:pass   require proxy authentication (407 / SOCKS5 RFC1929 / SOCKS4 userid)
 *   --egress-file <path>       record the observed client address (egress echo tests)
 */

import fs from 'node:fs';
import net from 'node:net';

const args = process.argv.slice(2);
const readArg = (name, fallback = undefined) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const protocol = readArg('protocol', 'http');
const mode = readArg('mode', 'forward');
const delayMs = Number(readArg('delay', '0'));
const requireAuth = readArg('require-auth', null);
const egressFile = readArg('egress-file', null);
const requestedPort = Number(readArg('port', '0'));
const [authUser, authPass] = requireAuth ? requireAuth.split(':') : [null, null];

if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) {
  process.stdout.write(`ERROR unknown protocol ${protocol}\n`);
  process.exit(1);
}

/**
 * Accumulating reader: one 'data' handler per socket, no `unshift` tricks, so mixing protocol
 * phases (handshake then payload) is reliable.
 */
class Reader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.ended = false;
    this.pending = null;
    socket.on('data', (chunk) => {
      this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.#wake();
    });
    socket.on('end', () => {
      this.ended = true;
      this.#wake();
    });
    socket.on('close', () => {
      this.ended = true;
      this.#wake();
    });
    socket.on('error', () => {
      this.ended = true;
      this.#wake();
    });
  }

  #wake() {
    if (!this.pending) return;
    const { min, lineMode, resolve, reject, timer } = this.pending;
    if (lineMode ? this.buffer.indexOf('\r\n') !== -1 : this.buffer.length >= min) {
      clearTimeout(timer);
      this.pending = null;
      resolve();
    } else if (this.ended) {
      clearTimeout(timer);
      this.pending = null;
      reject(new Error('connection closed while reading'));
    }
  }

  #waitFor({ min = 1, lineMode = false, timeout = 10_000 }) {
    if (this.pending) throw new Error('reader is already busy');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('read timed out'));
      }, timeout);
      this.pending = { min, lineMode, resolve, reject, timer };
      this.#wake();
    });
  }

  async readLine(timeout) {
    if (this.buffer.indexOf('\r\n') === -1) await this.#waitFor({ lineMode: true, timeout });
    const index = this.buffer.indexOf('\r\n');
    if (index === -1) {
      const rest = this.buffer.toString('latin1');
      this.buffer = Buffer.alloc(0);
      return rest;
    }
    const line = this.buffer.subarray(0, index).toString('latin1');
    this.buffer = this.buffer.subarray(index + 2);
    return line;
  }

  async readBytes(count, timeout = 10_000) {
    if (this.buffer.length < count) await this.#waitFor({ min: count, timeout });
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  /** Bytes received before the tunnel was established must not be lost. */
  handoff() {
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest;
  }
}

const parseHostPort = (value, defaultPort) => {
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return { host: value.slice(1, end), port: Number(value.slice(end + 2)) || defaultPort };
  }
  const [host, port] = value.split(':');
  return { host, port: Number(port) || defaultPort };
};

const pump = (from, to, firstDelayMs = 0) => {
  let first = true;
  from.on('data', (chunk) => {
    if (first && firstDelayMs > 0) {
      first = false;
      setTimeout(() => to.write(chunk), firstDelayMs);
      return;
    }
    first = false;
    if (to.writable) to.write(chunk);
  });
  from.on('end', () => {
    if (to.writable) to.end();
  });
  from.on('error', () => to.destroy());
};

const openTarget = (host, port) =>
  new Promise((resolve, reject) => {
    const upstream = net.connect({ host, port });
    const onError = (error) => {
      upstream.destroy();
      reject(error);
    };
    upstream.once('error', onError);
    upstream.once('connect', () => {
      upstream.removeListener('error', onError);
      resolve(upstream);
    });
    upstream.setTimeout(5_000, () => onError(new Error('target connect timed out')));
  });

const closeQuietly = (socket) => {
  try {
    socket.destroy();
  } catch {
    /* ignore */
  }
};

const handleHttp = async (reader, client) => {
  if (mode === 'hang') return;
  const requestLine = await reader.readLine();
  const [method, target] = requestLine.split(/\s+/);
  const headerLines = [];
  for (;;) {
    const line = await reader.readLine();
    if (line.length === 0) break;
    headerLines.push(line);
  }
  if (!target) {
    client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    return;
  }

  const isConnect = method === 'CONNECT';
  const authority = isConnect
    ? target
    : target.includes('://')
      ? target.slice(target.indexOf('://') + 3).split('/')[0]
      : target.split('/')[0];
  const { host, port } = parseHostPort(
    authority,
    isConnect ? 443 : target.startsWith('https://') ? 443 : 80,
  );

  if (authUser) {
    // Very small "proxy auth" emulation for the HTTP proxy path.
    let supplied = null;
    for (const line of headerLines) {
      if (line.toLowerCase().startsWith('proxy-authorization:')) {
        supplied = line
          .slice(line.indexOf(':') + 1)
          .trim()
          .replace(/^basic\s+/i, '');
      }
    }
    if (supplied !== Buffer.from(`${authUser}:${authPass}`).toString('base64')) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="mock"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
      return;
    }
  }

  if (mode === 'reject') {
    client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    return;
  }
  if (mode === 'deny-connect') {
    client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    return;
  }

  let upstream;
  try {
    upstream = await openTarget(host, port);
  } catch (error) {
    client.end(
      `HTTP/1.1 502 Bad Gateway\r\nX-Mock-Error: ${error.message}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
    return;
  }

  if (isConnect) {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const pending = reader.handoff();
    if (pending.length > 0) upstream.write(pending);
    pump(client, upstream, mode === 'slow' ? delayMs : 0);
    pump(upstream, client, mode === 'slow' ? delayMs : 0);
    return;
  }

  const path = target.includes('://')
    ? (() => {
        const withoutScheme = target.slice(target.indexOf('://') + 3);
        const slash = withoutScheme.indexOf('/');
        return slash === -1 ? '/' : withoutScheme.slice(slash);
      })()
    : `/${target.split('/').slice(1).join('/')}`;
  const forward = () =>
    upstream.write(
      `${method} ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nX-Forwarded-For: ${client.remoteAddress ?? 'unknown'}\r\nUser-Agent: mock-proxy\r\nConnection: close\r\n\r\n`,
    );
  // "slow" delays the forwarded request, so the answer really is slow to start and the upstream
  // close cannot race with the delayed write.
  if (mode === 'slow') setTimeout(forward, delayMs);
  else forward();
  pump(upstream, client);
  pump(client, upstream);
};

const handleSocks5 = async (reader, client) => {
  if (mode === 'hang') return;
  const header = await reader.readBytes(2);
  if (header[0] !== 0x05) return closeQuietly(client);
  const methodCount = header[1];
  const methods = await reader.readBytes(methodCount);

  const wantsPassword = authUser !== null;
  if (wantsPassword) {
    if (!methods.includes(0x02)) {
      client.write(Buffer.from([0x05, 0xff]));
      return closeQuietly(client);
    }
    client.write(Buffer.from([0x05, 0x02]));
    const version = await reader.readBytes(1);
    if (version[0] !== 0x01) return closeQuietly(client);
    const userLen = (await reader.readBytes(1))[0];
    const user = (await reader.readBytes(userLen)).toString('utf8');
    const passLen = (await reader.readBytes(1))[0];
    const pass = (await reader.readBytes(passLen)).toString('utf8');
    if (user !== authUser || pass !== authPass) {
      client.write(Buffer.from([0x01, 0x01]));
      return closeQuietly(client);
    }
    client.write(Buffer.from([0x01, 0x00]));
  } else {
    client.write(Buffer.from([0x05, 0x00]));
  }

  const request = await reader.readBytes(4);
  if (request[0] !== 0x05 || request[1] !== 0x01) {
    client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    return closeQuietly(client);
  }

  let host;
  let port;
  if (request[3] === 0x01) {
    const bytes = await reader.readBytes(6);
    host = bytes.subarray(0, 4).join('.');
    port = bytes.readUInt16BE(4);
  } else if (request[3] === 0x03) {
    const length = (await reader.readBytes(1))[0];
    const bytes = await reader.readBytes(length + 2);
    host = bytes.subarray(0, length).toString('utf8');
    port = bytes.readUInt16BE(length);
  } else if (request[3] === 0x04) {
    const bytes = await reader.readBytes(18);
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(bytes.readUInt16BE(i).toString(16));
    host = parts.join(':');
    port = bytes.readUInt16BE(16);
  } else {
    client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    return closeQuietly(client);
  }

  if (mode === 'reject' || mode === 'deny-connect') {
    client.write(
      Buffer.from([0x05, mode === 'deny-connect' ? 0x02 : 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
    );
    return closeQuietly(client);
  }

  try {
    const upstream = await openTarget(host, port);
    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
    const pending = reader.handoff();
    if (pending.length > 0) upstream.write(pending);
    pump(client, upstream, mode === 'slow' ? delayMs : 0);
    pump(upstream, client, mode === 'slow' ? delayMs : 0);
  } catch {
    client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    closeQuietly(client);
  }
};

const handleSocks4 = async (reader, client) => {
  if (mode === 'hang') return;
  const head = await reader.readBytes(8);
  if (head[0] !== 0x04 || head[1] !== 0x01) return closeQuietly(client);
  const port = head.readUInt16BE(2);
  const ip = [head[4], head[5], head[6], head[7]];

  let userId = '';
  for (;;) {
    const byte = await reader.readBytes(1);
    if (byte[0] === 0x00) break;
    userId += byte.toString('latin1');
    if (userId.length > 256) return closeQuietly(client);
  }
  if (authUser && userId !== authUser) {
    client.write(Buffer.from([0x00, 0x5c, 0, 0, 0, 0, 0, 0]));
    return closeQuietly(client);
  }

  let host = ip.join('.');
  if (ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0) {
    let name = '';
    for (;;) {
      const byte = await reader.readBytes(1);
      if (byte[0] === 0x00) break;
      name += byte.toString('latin1');
      if (name.length > 256) return closeQuietly(client);
    }
    host = name;
  }

  if (mode === 'reject' || mode === 'deny-connect') {
    client.write(Buffer.from([0x00, mode === 'deny-connect' ? 0x5b : 0x5b, 0, 0, 0, 0, 0, 0]));
    return closeQuietly(client);
  }

  try {
    const upstream = await openTarget(host, port);
    client.write(
      Buffer.from([0x00, 0x5a, head[2], head[3], ip[0] ?? 0, ip[1] ?? 0, ip[2] ?? 0, ip[3] ?? 0]),
    );
    const pending = reader.handoff();
    if (pending.length > 0) upstream.write(pending);
    pump(client, upstream, mode === 'slow' ? delayMs : 0);
    pump(upstream, client, mode === 'slow' ? delayMs : 0);
  } catch {
    client.write(Buffer.from([0x00, 0x5b, 0, 0, 0, 0, 0, 0]));
    closeQuietly(client);
  }
};

const server = net.createServer((client) => {
  client.on('error', () => closeQuietly(client));
  if (egressFile) {
    try {
      fs.writeFileSync(egressFile, `${client.remoteAddress}:${client.remotePort}`);
    } catch {
      /* best effort */
    }
  }
  const reader = new Reader(client);
  const handler =
    protocol === 'socks5' ? handleSocks5 : protocol === 'socks4' ? handleSocks4 : handleHttp;
  handler(reader, client).catch(() => closeQuietly(client));
});

server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`LISTENING ${address.port} ${protocol} ${mode}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
