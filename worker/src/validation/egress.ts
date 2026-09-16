/**
 * Egress echo analysis.
 *
 * Some check endpoints reflect the address the request appeared to come from (for example a JSON
 * `{"origin": "1.2.3.4"}` body). We use that for one safety property only: a "proxy" whose observed
 * egress address is local is really just a loop to ourselves, so it must never enter the pool. The
 * address itself is not stored or logged.
 */

import { inspectAddress, parseIpv4 } from '@proxypulse/shared';

const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const ORIGIN_KEYS = [
  'origin',
  'ip',
  'ip_address',
  'client_ip',
  'x-forwarded-for',
  'egress',
  'peer',
];

export function extractEgressAddress(body: string): string | null {
  if (body.length === 0) return null;
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed.slice(0, 8_192)) as Record<string, unknown>;
      for (const key of ORIGIN_KEYS) {
        const value = parsed[key];
        if (typeof value === 'string') {
          const match = IPV4_RE.exec(value) ?? /([0-9a-f:]+(?:\.[0-9a-f:]+)*)/i.exec(value.trim());
          if (match) return match[0]!;
        }
        if (typeof value === 'number') return String(value);
      }
    } catch {
      /* fall through to the text scan below */
    }
  }
  const direct = IPV4_RE.exec(trimmed.slice(0, 4_096));
  if (direct) return direct[0]!;
  const ipv6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/i.exec(trimmed.slice(0, 4_096));
  return ipv6 ? ipv6[0]! : null;
}

/** True for loopback / private / link-local / metadata answers. */
export function egressLooksLocal(address: string): boolean {
  const cleaned = address.replace(/^\[|\]$/g, '');
  if (/^::ffff:/i.test(cleaned)) {
    const embedded = cleaned.slice(7);
    if (parseIpv4(embedded)) return egressLooksLocal(embedded);
  }
  const verdict = inspectAddress(cleaned);
  if (verdict.kind === 'hostname') return false;
  return verdict.blocked;
}
