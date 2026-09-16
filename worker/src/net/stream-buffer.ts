/**
 * Buffered reader over a `node:net` socket. Shared by the SOCKS handshake and the HTTP response
 * parser so leftover bytes are never lost between protocol phases.
 */

import type { Socket } from 'node:net';

export class StreamClosedError extends Error {
  readonly code = 'connection_closed';
  constructor(message = 'connection closed before the response was complete') {
    super(message);
    this.name = 'StreamClosedError';
  }
}

export class StreamTimeoutError extends Error {
  readonly code = 'timeout';
  constructor(ms: number, what: string) {
    super(`timed out after ${ms}ms waiting for ${what}`);
    this.name = 'StreamTimeoutError';
  }
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  min: number;
}

export class StreamBuffer {
  #buffer: Buffer = Buffer.alloc(0);
  #ended = false;
  #error: Error | null = null;
  #waiters: Waiter[] = [];

  constructor(
    private readonly socket: Socket,
    /** Bytes already buffered by a previous reader (e.g. a proxy tunnel handshake). */
    initial?: Buffer,
  ) {
    if (initial && initial.length > 0) this.#buffer = Buffer.from(initial);
    socket.on('data', this.#onData);
    socket.on('end', this.#onEnd);
    socket.on('close', this.#onEnd);
    socket.on('error', this.#onError);
  }

  #onData = (chunk: Buffer): void => {
    this.#buffer = this.#buffer.length > 0 ? Buffer.concat([this.#buffer, chunk]) : chunk;
    this.#signal();
  };

  #onEnd = (): void => {
    this.#ended = true;
    this.#signal();
  };

  #onError = (error: Error): void => {
    this.#error = error;
    this.#signal();
  };

  #signal(): void {
    for (const waiter of [...this.#waiters]) {
      if (this.#error) {
        clearTimeout(waiter.timer);
        this.#remove(waiter);
        waiter.reject(this.#error);
      } else if (this.#buffer.length >= waiter.min || this.#ended) {
        clearTimeout(waiter.timer);
        this.#remove(waiter);
        waiter.resolve();
      }
    }
  }

  #remove(waiter: Waiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index !== -1) this.#waiters.splice(index, 1);
  }

  get length(): number {
    return this.#buffer.length;
  }

  #destroyed = false;

  get destroyed(): boolean {
    return this.#destroyed;
  }

  /** Writes to the underlying socket. Kept here so protocol phases share one object. */
  write(chunk: Buffer): void {
    if (this.#destroyed) throw new StreamClosedError('socket already closed');
    this.socket.write(chunk);
  }

  /** Aborts the socket (used when a response is truncated on purpose). */
  destroySocket(): void {
    this.socket.destroy();
  }

  get ended(): boolean {
    return this.#ended;
  }

  get buffered(): Buffer {
    return this.#buffer;
  }

  /** Waits until at least `min` bytes are buffered (or the stream ends/errors). */
  wait(min: number, timeoutMs: number, what = 'data'): Promise<void> {
    if (this.#buffer.length >= min || this.#ended || this.#error) {
      if (this.#error) return Promise.reject(this.#error);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#remove(waiter);
          reject(new StreamTimeoutError(timeoutMs, what));
        },
        Math.max(1, timeoutMs),
      );
      const waiter = { resolve, reject, timer, min };
      this.#waiters.push(waiter);
      this.#signal();
    });
  }

  /** Scans the buffer for `needle`; returns its index or -1 when not present. */
  indexOf(needle: Buffer): number {
    return this.#buffer.indexOf(needle);
  }

  consume(bytes: number): void {
    this.#buffer = this.#buffer.subarray(Math.min(bytes, this.#buffer.length));
  }

  take(bytes: number): Buffer {
    const out = this.#buffer.subarray(0, Math.min(bytes, this.#buffer.length));
    this.consume(bytes);
    return out;
  }

  /** Returns everything currently buffered and clears the buffer (used when the stream ends). */
  drain(): Buffer {
    const out = this.#buffer;
    this.#buffer = Buffer.alloc(0);
    return out;
  }

  /**
   * Removes the listeners but keeps buffered bytes: used right before handing the socket to
   * `tls.connect()`, which must be the only consumer from that point on.
   */
  detach(): Buffer {
    this.#destroyed = true;
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new StreamClosedError('socket handed over to TLS'));
    }
    this.#waiters = [];
    this.socket.removeListener('data', this.#onData);
    this.socket.removeListener('end', this.#onEnd);
    this.socket.removeListener('close', this.#onEnd);
    this.socket.removeListener('error', this.#onError);
    return this.#buffer;
  }

  destroy(): void {
    this.#destroyed = true;
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new StreamClosedError());
    }
    this.#waiters = [];
    this.#buffer = Buffer.alloc(0);
    this.socket.removeListener('data', this.#onData);
    this.socket.removeListener('end', this.#onEnd);
    this.socket.removeListener('close', this.#onEnd);
    this.socket.removeListener('error', this.#onError);
  }
}
