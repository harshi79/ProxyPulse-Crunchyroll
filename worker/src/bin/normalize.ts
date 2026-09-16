/**
 * Dev utility: read a proxy list from stdin (or a file) and print how ProxyPulse would interpret it —
 * normalisation, protocol detection, dedup and the network policy verdict. Nothing about a source's
 * syntax should ever be guessed at: this is the quickest way to check a new provider's list format.
 *
 *   npm run pipeline:normalize -- --file /tmp/list.txt
 *   cat /tmp/list.txt | node worker/dist/bin/normalize.js
 *
 * Output never contains credentials, only whether a username is present.
 */

import { readFileSync } from 'node:fs';
import {
  parseProxyList,
  isProxyEndpointAllowed,
  formatProxyRedacted,
  dedupeKeyHash,
} from '@proxypulse/shared';

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const path = argValue('file') ?? args.find((value) => !value.startsWith('--'));
const hint = argValue('protocol') as 'http' | 'https' | 'socks4' | 'socks5' | undefined;
const allowPrivate = args.includes('--allow-private');

const input = path === undefined ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
const parsed = parseProxyList(input, {
  ...(hint ? { protocolHint: hint } : {}),
  maxEntries: Number(argValue('max') ?? '5000'),
});

const rows = parsed.proxies.map((proxy) => ({
  redacted: formatProxyRedacted(proxy),
  protocol: proxy.protocol,
  host: proxy.host,
  port: proxy.port,
  credentials: proxy.username === undefined ? 'none' : 'username',
  anonymity: proxy.anonymity,
  country: proxy.country ?? null,
  dedupe_key: dedupeKeyHash(proxy),
  allowed: isProxyEndpointAllowed(proxy.host, { allowPrivate }).ok,
}));

process.stdout.write(
  `${JSON.stringify(
    {
      total_lines: parsed.total_lines,
      skipped_lines: parsed.skipped_lines,
      accepted: rows.length,
      rejected: parsed.rejected.length,
      duplicates_removed: parsed.duplicates,
      rows,
      rejection_samples: parsed.rejected.slice(0, 25),
    },
    null,
    2,
  )}\n`,
);
