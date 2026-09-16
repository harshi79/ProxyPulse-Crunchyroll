/**
 * Test helpers: spawn the local mock proxy/target servers from `scripts/` and wait until they
 * report their listening port. Keeping the mocks as standalone scripts means the demo script and
 * the tests exercise exactly the same code paths.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = fileURLToPath(new URL('../../scripts', import.meta.url));

export interface StartedProcess {
  port: number;
  proc: ChildProcess;
  stop: () => Promise<void>;
}

export type MockProxyMode = 'forward' | 'hang' | 'reject' | 'deny-connect' | 'slow';
export type MockProxyProtocol = 'http' | 'socks4' | 'socks5';

const spawnWaiting = (file: string, args: string[]): Promise<StartedProcess> =>
  new Promise((resolveStart, rejectStart) => {
    const proc = spawn(process.execPath, [join(SCRIPTS_DIR, file), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      rejectStart(new Error(`${file} did not report a listening port in time: ${stdout}`));
    }, 10_000);

    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      process.stderr.write(`[${file}] ${chunk}`);
    });
    proc.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /LISTENING (\d+)/.exec(stdout);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        const port = Number(match[1]);
        resolveStart({
          port,
          proc,
          stop: async () => {
            if (proc.exitCode === null && proc.signalCode === null) {
              proc.kill('SIGTERM');
              await once(proc, 'exit').catch(() => undefined);
            }
          },
        });
      }
    });
    proc.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectStart(new Error(`${file} exited early with code ${String(code)}: ${stdout}`));
      }
    });
  });

export const startMockTarget = (): Promise<StartedProcess> =>
  spawnWaiting('mock-target-server.mjs', ['--port', '0']);

export const startMockProxy = (
  protocol: MockProxyProtocol,
  options: { mode?: MockProxyMode; requireAuth?: string; delayMs?: number } = {},
): Promise<StartedProcess> => {
  const args = ['--protocol', protocol, '--port', '0', '--mode', options.mode ?? 'forward'];
  if (options.requireAuth) args.push('--require-auth', options.requireAuth);
  if (options.delayMs !== undefined) args.push('--delay', String(options.delayMs));
  return spawnWaiting('mock-proxy-server.mjs', args);
};

/** Minimal HTTP GET used by the tests themselves (never through a proxy). */
export const directGet = (
  port: number,
  path: string,
): Promise<{ status: number; body: string; headers: Record<string, string> }> =>
  new Promise((resolveGet, rejectGet) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
      );
    });
    let raw = '';
    socket.setTimeout(5_000, () => {
      socket.destroy();
      rejectGet(new Error('directGet timed out'));
    });
    socket.on('data', (chunk: Buffer) => {
      raw += chunk.toString('latin1');
    });
    socket.on('end', () => {
      socket.destroy();
      const [head, body = ''] = raw.split('\r\n\r\n');
      const statusLine = (head ?? '').split('\r\n')[0] ?? '';
      const status = Number(/HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1] ?? 0);
      const headers: Record<string, string> = {};
      for (const line of (head ?? '').split('\r\n').slice(1)) {
        const index = line.indexOf(':');
        if (index > 0) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
      }
      // de-chunk when needed so assertions are simple
      let text = body;
      if (/transfer-encoding:\s*chunked/i.test(head ?? '')) {
        const chunks: string[] = [];
        let rest = body;
        for (;;) {
          const lineEnd = rest.indexOf('\r\n');
          if (lineEnd === -1) break;
          const size = Number.parseInt(rest.slice(0, lineEnd).split(';')[0]!, 16);
          if (!Number.isFinite(size) || size === 0) break;
          chunks.push(rest.slice(lineEnd + 2, lineEnd + 2 + size));
          rest = rest.slice(lineEnd + 2 + size + 2);
        }
        text = chunks.join('');
      }
      resolveGet({ status, body: text, headers });
    });
    socket.on('error', rejectGet);
  });
