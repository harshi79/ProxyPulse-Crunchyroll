/**
 * Minimal SOCKS4 / SOCKS4a / SOCKS5 client (CONNECT only, no UDP, no BIND).
 *
 * Written by hand on purpose: it keeps the dependency footprint tiny and lets us apply our own
 * timeouts and error classification on every read.
 */

import { Buffer } from 'node:buffer';

import { parseIpv4, parseIpv6 } from '@proxypulse/shared';

import { type StreamBuffer } from './stream-buffer.js';

export class ProxyHandshakeError extends Error {
  constructor(
    readonly code:
      'protocol_error' | 'proxy_auth_failed' | 'proxy_bad_gateway' | 'connect_refused' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'ProxyHandshakeError';
  }
}

export interface SocksTarget {
  host: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
}

const remainingOf = (deadline: number): number => Math.max(1, deadline - Date.now());

function encodeAddress(host: string): { atyp: 1 | 3 | 4; bytes: Buffer } {
  const v4 = parseIpv4(host);
  if (v4) return { atyp: 1, bytes: Buffer.from(v4) };
  const v6 = parseIpv6(host);
  if (v6) return { atyp: 4, bytes: Buffer.from(v6) };
  const encoded = Buffer.from(host, 'utf8');
  if (encoded.length > 255)
    throw new ProxyHandshakeError('protocol_error', 'hostname too long for SOCKS domain ATYP');
  return { atyp: 3, bytes: encoded };
}

const SOCKS5_ERRORS: Record<number, { code: ProxyHandshakeError['code']; message: string }> = {
  1: { code: 'proxy_bad_gateway', message: 'SOCKS5 server: general failure' },
  2: { code: 'proxy_bad_gateway', message: 'SOCKS5 server: connection not allowed by ruleset' },
  3: { code: 'proxy_bad_gateway', message: 'SOCKS5 server: network unreachable' },
  4: { code: 'proxy_bad_gateway', message: 'SOCKS5 server: host unreachable' },
  5: { code: 'connect_refused', message: 'SOCKS5 server: connection refused' },
  6: { code: 'timeout', message: 'SOCKS5 server: TTL expired' },
  7: { code: 'timeout', message: 'SOCKS5 server: command timed out' },
  8: { code: 'protocol_error', message: 'SOCKS5 server: command not supported' },
  9: { code: 'protocol_error', message: 'SOCKS5 server: address type not supported' },
};

/** SOCKS5 greeting (+ optional RFC1929 username/password auth) then CONNECT. */
export async function socks5Connect(
  stream: StreamBuffer,
  target: SocksTarget,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const usesAuth = Boolean(target.username && target.password !== undefined);
  stream.write(usesAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));

  await stream.wait(2, remainingOf(deadline), 'SOCKS5 greeting');
  const greeting = stream.take(2);
  if (greeting[0] !== 0x05)
    throw new ProxyHandshakeError('protocol_error', 'not a SOCKS5 response');
  const method = greeting[1];
  if (method === 0xff) {
    // 0xFF always means "I will not talk to you without authentication" for our greeting.
    throw new ProxyHandshakeError(
      'proxy_auth_failed',
      'SOCKS5 server rejected every authentication method',
    );
  }
  if (method === 0x02) {
    if (!usesAuth)
      throw new ProxyHandshakeError(
        'proxy_auth_failed',
        'SOCKS5 server requires username/password auth',
      );
    const user = Buffer.from(target.username ?? '', 'utf8');
    const pass = Buffer.from(target.password ?? '', 'utf8');
    stream.write(
      Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]),
    );
    await stream.wait(2, remainingOf(deadline), 'SOCKS5 auth response');
    const auth = stream.take(2);
    if (auth[0] !== 0x01)
      throw new ProxyHandshakeError('protocol_error', 'malformed SOCKS5 auth response');
    if (auth[1] !== 0x00)
      throw new ProxyHandshakeError('proxy_auth_failed', 'SOCKS5 authentication failed');
  } else if (method !== 0x00) {
    throw new ProxyHandshakeError('protocol_error', `unsupported SOCKS5 auth method ${method}`);
  }

  const { atyp, bytes } = encodeAddress(target.host);
  const port = Buffer.alloc(2);
  port.writeUInt16BE(target.port);
  stream.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), bytes, port]));

  await stream.wait(4, remainingOf(deadline), 'SOCKS5 CONNECT reply');
  const head = stream.buffered.subarray(0, 4);
  if (head[0] !== 0x05) throw new ProxyHandshakeError('protocol_error', 'malformed SOCKS5 reply');
  let replyLength: number;
  switch (head[3]) {
    case 1:
      replyLength = 10; // IPv4 (4) + port (2)
      break;
    case 4:
      replyLength = 22; // IPv6 (16) + port (2)
      break;
    case 3: {
      await stream.wait(5, remainingOf(deadline), 'SOCKS5 domain length');
      replyLength = 5 + stream.buffered[4]! + 2;
      break;
    }
    default:
      replyLength = 4;
  }
  await stream.wait(replyLength, remainingOf(deadline), 'SOCKS5 reply address');
  const reply = stream.take(replyLength);
  const rep = reply[1]!;
  if (rep !== 0x00) {
    const mapped = SOCKS5_ERRORS[rep] ?? {
      code: 'proxy_bad_gateway',
      message: `SOCKS5 server error ${rep}`,
    };
    throw new ProxyHandshakeError(mapped.code, mapped.message);
  }
}

/** SOCKS4/4a CONNECT. IPv6 targets are not supported by the protocol. */
export async function socks4Connect(
  stream: StreamBuffer,
  target: SocksTarget,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const port = Buffer.alloc(2);
  port.writeUInt16BE(target.port);
  const userId = Buffer.from((target.username ?? 'proxypulse').slice(0, 255), 'utf8');
  const v4 = parseIpv4(target.host);

  let packet: Buffer;
  if (v4) {
    packet = Buffer.concat([
      Buffer.from([0x04, 0x01]),
      port,
      Buffer.from(v4),
      userId,
      Buffer.from([0x00]),
    ]);
  } else {
    if (parseIpv6(target.host)) {
      throw new ProxyHandshakeError('protocol_error', 'SOCKS4 does not support IPv6 targets');
    }
    const encodedHost = Buffer.from(target.host, 'utf8');
    if (encodedHost.length > 255)
      throw new ProxyHandshakeError('protocol_error', 'hostname too long for SOCKS4a');
    // SOCKS4a: DSTIP 0.0.0.x (x != 0) signals "resolve the domain name I am sending you".
    packet = Buffer.concat([
      Buffer.from([0x04, 0x01]),
      port,
      Buffer.from([0x00, 0x00, 0x00, 0x01]),
      userId,
      Buffer.from([0x00]),
      encodedHost,
      Buffer.from([0x00]),
    ]);
  }

  stream.write(packet);
  await stream.wait(8, remainingOf(deadline), 'SOCKS4 reply');
  const reply = stream.take(8);
  if (reply[0] !== 0x00) throw new ProxyHandshakeError('protocol_error', 'malformed SOCKS4 reply');
  const code = reply[1]!;
  if (code === 0x5a) return;
  if (code === 0x5b)
    throw new ProxyHandshakeError('connect_refused', 'SOCKS4 server: request rejected');
  if (code === 0x5c || code === 0x5d) {
    throw new ProxyHandshakeError(
      'proxy_auth_failed',
      'SOCKS4 server: identd authentication failed',
    );
  }
  throw new ProxyHandshakeError('proxy_bad_gateway', `SOCKS4 server error code ${code}`);
}
