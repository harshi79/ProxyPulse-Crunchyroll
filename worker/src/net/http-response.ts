/**
 * Defensive HTTP/1.x response reader.
 *
 * Public proxies lie about framing all the time, so this parser tolerates missing Content-Length
 * (read-until-close) and closes the socket as soon as the byte cap is reached. It never buffers more
 * than `maxBytes`.
 */

import { Buffer } from 'node:buffer';
import type { Socket } from 'node:net';

import { StreamBuffer, StreamClosedError } from './stream-buffer.js';

const CRLF = Buffer.from('\r\n', 'latin1');
const HEADER_END = Buffer.from('\r\n\r\n', 'latin1');
const MAX_HEADER_BYTES = 32 * 1024;

export class HttpProtocolError extends Error {
  readonly code = 'protocol_error';
  constructor(message: string) {
    super(message);
    this.name = 'HttpProtocolError';
  }
}

export interface ParsedHttpResponse {
  httpVersion: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}

const remainingOf = (deadline: number): number => Math.max(1, deadline - Date.now());

export const isBodylessStatus = (status: number): boolean =>
  (status >= 100 && status < 200) || status === 204 || status === 304;

async function readLine(stream: StreamBuffer, deadline: number): Promise<string> {
  for (;;) {
    const index = stream.indexOf(CRLF);
    if (index !== -1) {
      const line = stream.buffered.subarray(0, index).toString('latin1');
      stream.consume(index + 2);
      return line;
    }
    if (stream.length > 8 * 1024) throw new HttpProtocolError('over-long status line');
    if (stream.ended) return stream.drain().toString('latin1');
    await stream.wait(stream.length + 1, remainingOf(deadline), 'response line');
  }
}

async function readExactly(stream: StreamBuffer, bytes: number, deadline: number): Promise<Buffer> {
  await stream.wait(bytes, remainingOf(deadline), 'response body');
  if (stream.length < bytes) {
    if (!stream.ended) throw new StreamClosedError('connection closed mid-body');
    return stream.drain();
  }
  return stream.take(bytes);
}

async function readChunkedBody(
  stream: StreamBuffer,
  maxBytes: number,
  deadline: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  const parts: Buffer[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const sizeLine = await readLine(stream, deadline);
    const size = Number.parseInt(sizeLine.split(';')[0]!.trim(), 16);
    if (!Number.isFinite(size) || size < 0) throw new HttpProtocolError('malformed chunk size');
    if (size === 0) {
      // trailers
      for (;;) {
        const trailer = await readLine(stream, deadline);
        if (trailer.length === 0) break;
      }
      break;
    }
    if (total + size > maxBytes) {
      truncated = true;
      stream.destroySocket();
      break;
    }
    parts.push(await readExactly(stream, size, deadline));
    total += size;
    await readExactly(stream, 2, deadline); // trailing CRLF
    if (stream.ended) break;
  }

  return { body: Buffer.concat(parts), truncated };
}

async function readUntilEnd(
  stream: StreamBuffer,
  maxBytes: number,
  deadline: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  const parts: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    if (stream.length > 0) {
      const chunk = stream.drain();
      if (total + chunk.length > maxBytes) {
        parts.push(chunk.subarray(0, Math.max(0, maxBytes - total)));
        truncated = true;
        stream.destroySocket();
        break;
      }
      parts.push(chunk);
      total += chunk.length;
    }
    if (stream.ended || truncated) break;
    await stream.wait(stream.length + 1, remainingOf(deadline), 'response body');
  }
  return { body: Buffer.concat(parts), truncated };
}

export async function readHttpResponse(
  stream: StreamBuffer,
  options: { timeoutMs: number; maxBytes: number; noBody?: boolean },
): Promise<ParsedHttpResponse> {
  const deadline = Date.now() + Math.max(1, options.timeoutMs);

  let headerEnd = stream.indexOf(HEADER_END);
  while (headerEnd === -1) {
    if (stream.length > MAX_HEADER_BYTES) throw new HttpProtocolError('response headers too large');
    if (stream.ended)
      throw new StreamClosedError('connection closed before the response headers were complete');
    await stream.wait(stream.length + 1, remainingOf(deadline), 'response headers');
    headerEnd = stream.indexOf(HEADER_END);
  }

  const rawHeaders = stream.buffered.subarray(0, headerEnd).toString('latin1');
  stream.consume(headerEnd + 4);

  const [statusLine = '', ...headerLines] = rawHeaders.split('\r\n');
  const match = /^HTTP\/(\d(?:\.\d)?)\s+(\d{3})\s*(.*)$/.exec(statusLine.trim());
  if (!match) throw new HttpProtocolError(`invalid status line: ${statusLine.slice(0, 64)}`);

  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    if (line.length === 0) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name.length === 0 || name.length > 64) continue;
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }

  const status = Number(match[2]);
  const parsed: ParsedHttpResponse = {
    httpVersion: match[1] ?? '1.1',
    status,
    statusText: (match[3] ?? '').trim(),
    headers,
    body: Buffer.alloc(0),
    truncated: false,
  };
  if (options.noBody || isBodylessStatus(status) || status === 0) return parsed;

  const chunked = /chunked/i.test(headers['transfer-encoding'] ?? '');
  const declaredLength = Number(headers['content-length']);
  const maxBytes = Math.max(0, options.maxBytes);

  if (chunked) {
    const body = await readChunkedBody(stream, maxBytes, deadline);
    parsed.body = body.body;
    parsed.truncated = body.truncated;
    return parsed;
  }
  if (Number.isFinite(declaredLength) && declaredLength >= 0) {
    if (declaredLength > maxBytes) {
      parsed.body = await readExactly(stream, maxBytes, deadline);
      parsed.truncated = true;
      stream.destroySocket();
      return parsed;
    }
    parsed.body = await readExactly(stream, declaredLength, deadline);
    return parsed;
  }
  if (stream.ended) return parsed;

  const body = await readUntilEnd(stream, maxBytes, deadline);
  parsed.body = body.body;
  parsed.truncated = body.truncated;
  return parsed;
}

/** Reads one response straight off a socket (used by the direct fetcher). */
export async function readHttpResponseFromSocket(
  socket: Socket,
  options: { timeoutMs: number; maxBytes: number; noBody?: boolean },
): Promise<ParsedHttpResponse> {
  const stream = new StreamBuffer(socket);
  try {
    return await readHttpResponse(stream, options);
  } finally {
    stream.destroy();
  }
}

/** Absolute-form request line builder for plain HTTP proxies. */
export function absoluteFormTarget(url: URL): string {
  const path = url.pathname.length === 0 ? '/' : url.pathname;
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

export function buildHttpRequest(
  method: 'GET' | 'HEAD',
  target: string,
  hostHeader: string,
  headers: Record<string, string>,
): string {
  const lines = [`${method} ${target} HTTP/1.1`, `Host: ${hostHeader}`];
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(name)) continue;
    lines.push(`${name}: ${value.replace(/[\r\n]/g, '')}`);
  }
  lines.push('Connection: close');
  lines.push('Accept-Encoding: identity');
  return `${lines.join('\r\n')}\r\n\r\n`;
}
