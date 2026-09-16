/**
 * Address policy used by every outbound request ProxyPulse makes.
 *
 * Purpose: prevent the proxy pipeline (and therefore the public API) from being turned into an
 * SSRF primitive against localhost, private networks, link-local / cloud metadata endpoints or
 * other reserved ranges. Pure functions only — no Node APIs — so the Cloudflare Worker can reuse
 * them for user supplied input as well.
 */

export type AddressKind = 'hostname' | 'ipv4' | 'ipv6';

export type AddressClassification =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'cloud_metadata'
  | 'carrier_nat'
  | 'multicast'
  | 'reserved'
  | 'documentation'
  | 'benchmark'
  | 'unique_local'
  | 'unspecified'
  | 'invalid';

export interface AddressVerdict {
  blocked: boolean;
  kind: AddressKind;
  classification: AddressClassification;
  reason: string;
}

/** Prefixes/addresses that are never valid proxy or check targets. */
const BLOCKED_CLASSIFICATIONS = new Set<AddressClassification>([
  'loopback',
  'private',
  'link_local',
  'cloud_metadata',
  'carrier_nat',
  'multicast',
  'reserved',
  'documentation',
  'benchmark',
  'unique_local',
  'unspecified',
  'invalid',
]);

export function parseIpv4(input: string): [number, number, number, number] | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    if (part.length > 1 && part.startsWith('0')) return null; // reject 01 -> ambiguity/SSRF tricks
    octets.push(value);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/** Parses an IPv6 string (with `::` compression and optional embedded IPv4) into 16 bytes. */
export function parseIpv6(input: string): Uint8Array | null {
  let text = input.trim();
  if (text.length === 0) return null;
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);

  const doubleColon = text.indexOf('::');
  if (doubleColon !== -1 && text.indexOf('::', doubleColon + 1) !== -1) return null;

  let head = text;
  let tail = '';
  if (doubleColon !== -1) {
    head = text.slice(0, doubleColon);
    tail = text.slice(doubleColon + 2);
  }

  const parseGroup = (value: string): number | null => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(value)) return null;
    return Number.parseInt(value, 16);
  };

  const expand = (segment: string, out: number[]): boolean => {
    if (segment.length === 0) return true;
    // embedded IPv4 (e.g. ::ffff:1.2.3.4)
    if (segment.includes('.')) {
      const v4 = parseIpv4(segment);
      if (!v4) return false;
      out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      return true;
    }
    const groups = segment.split(':');
    for (const group of groups) {
      const parsed = parseGroup(group);
      if (parsed === null) return false;
      out.push(parsed);
    }
    return true;
  };

  const headGroups: number[] = [];
  const tailGroups: number[] = [];
  if (!expand(head, headGroups)) return null;
  if (!expand(tail, tailGroups)) return null;

  const groups: number[] = [...headGroups];
  if (doubleColon !== -1) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    for (let i = 0; i < missing; i++) groups.push(0);
    groups.push(...tailGroups);
  } else {
    groups.push(...tailGroups);
    if (groups.length !== 8) return null;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    bytes[i * 2] = (g >> 8) & 0xff;
    bytes[i * 2 + 1] = g & 0xff;
  }
  return bytes;
}

export function isIpv4Literal(host: string): boolean {
  return parseIpv4(host) !== null;
}

export function isIpv6Literal(host: string): boolean {
  if (!host.includes(':')) return false;
  return parseIpv6(host) !== null;
}

function classifyV4(octets: [number, number, number, number]): AddressClassification {
  const [a, b] = octets;
  if (a === 0) return 'unspecified'; // 0.0.0.0/8
  if (a === 10) return 'private'; // 10/8
  if (a === 127) return 'loopback'; // 127/8
  if (a === 100 && b! >= 64 && b! <= 127) return 'carrier_nat'; // 100.64/10 CGNAT
  if (a === 169 && b === 254)
    return octets[2] === 169 && octets[3] === 254 ? 'cloud_metadata' : 'link_local';
  if (a === 172 && b! >= 16 && b! <= 31) return 'private'; // 172.16/12
  if (a === 192 && b === 168) return 'private';
  if (a === 192 && b === 0 && octets[2] === 0) return 'reserved'; // 192.0.0.0/24
  if (a === 192 && b === 0 && octets[2] === 2) return 'documentation'; // TEST-NET-1
  if (a === 192 && b === 88 && octets[2] === 99) return 'reserved'; // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return 'benchmark'; // 198.18.0.0/15
  if (a === 198 && b === 51 && octets[2] === 100) return 'documentation'; // TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return 'documentation'; // TEST-NET-3
  if (a === 198 && b === 19) return 'benchmark';
  if (a! >= 224 && a! < 240) return 'multicast';
  if (a! >= 240) return 'reserved'; // 240/4 incl. 255.255.255.255
  return 'public';
}

function classifyV6Bytes(bytes: Uint8Array): AddressClassification {
  const b = bytes;
  const isZero = (from: number, to: number): boolean => {
    for (let i = from; i < to; i++) if (b[i] !== 0) return false;
    return true;
  };
  const high = (b[0]! << 8) | b[1]!;

  if (isZero(0, 16)) return 'unspecified'; // ::
  if (isZero(0, 15) && b[15] === 1) return 'loopback'; // ::1
  // ::ffff:0:0/96 — IPv4 mapped, evaluate the embedded v4 address.
  if (isZero(0, 10) && b[10] === 0xff && b[11] === 0xff) {
    const v4: [number, number, number, number] = [b[12]!, b[13]!, b[14]!, b[15]!];
    return classifyV4(v4);
  }
  // 64:ff9b::/96 — NAT64 well known, the v4 is embedded in the low 32 bits.
  if (high === 0x0064 && b[2] === 0xff && b[3] === 0x9b && isZero(4, 12)) {
    const v4: [number, number, number, number] = [b[12]!, b[13]!, b[14]!, b[15]!];
    return classifyV4(v4);
  }
  // 2002::/16 — 6to4, embedded IPv4 in bytes 2..5.
  if (high === 0x2002) {
    const v4: [number, number, number, number] = [b[2]!, b[3]!, b[4]!, b[5]!];
    return classifyV4(v4);
  }
  if (isZero(0, 12) === false && high === 0x0064 && b[2] === 0xff && b[3] === 0x9b)
    return 'reserved';
  if (high === 0x0100 && isZero(1, 16)) return 'reserved'; // 0100::/64 discard-only
  if (high === 0x2001 && b[2] === 0x0c && b[3] === 0x00) return 'documentation'; // 2001:db8::/32
  if ((b[0]! & 0xfe) === 0xfc) return 'unique_local'; // fc00::/7
  if (high === 0xfe80 || (high & 0xffc0) === 0xfe80) return 'link_local'; // fe80::/10
  if (b[0] === 0xfd) return 'unique_local';
  if (high === 0xfeb9) return 'reserved'; // AS112 v4-compatible blackhole
  if ((b[0]! & 0xff) === 0xff) return 'multicast'; // ff00::/8
  if (high === 0x2001 && b[2] === 0x00 && b[3] === 0x00) return 'public'; // teredo-ish 2001::/32 handled below
  if (high === 0x3ffe) return 'reserved'; // 3ffe::/16 legacy 6bone
  if (high === 0x2001 && b[2] === 0x00 && b[3] === 0x00) return 'public';
  if (isZero(0, 6) && b[6] === 0x00 && b[7] === 0x00) return 'reserved'; // IPv4-translated ::0.0.0.0/96
  if (high === 0x2001) return 'public';
  if (high === 0x2002) return 'public';
  return 'public';
}

/** AWS/GCP/OpenStack style metadata endpoints reachable over IPv6. */
function isV6Metadata(bytes: Uint8Array): boolean {
  // fd00:ec2::/64 (AWS IPv6 metadata) — matches the well known local-IMDS prefix.
  return bytes[0] === 0xfd && bytes[1] === 0x00 && bytes[2] === 0x0e && bytes[3] === 0xc2;
}

/**
 * glibc's resolver happily accepts octal (`0177.0.0.1`), hex (`0x7f.0.0.1`) and short form
 * (`2130706433`) IPv4 literals, and `127.1` style abbreviations. Every one of them is a textbook SSRF
 * bypass and none of them is how a real proxy or check endpoint is ever written, so they are refused
 * instead of being resolved.
 */
export function looksLikeNonCanonicalIpLiteral(host: string): boolean {
  const labels = host.split('.');
  if (labels.length === 0) return false;
  if (labels.length === 1) return /^\d+$/.test(labels[0] ?? '');
  if (labels.length > 4) return false;
  const allNumeric = labels.every((label) => /^(?:0[xX][0-9a-fA-F]+|\d+)$/.test(label));
  if (!allNumeric) return false;
  // `parseIpv4` already handled a clean dotted quad, so anything reaching here is a padded,
  // abbreviated or out-of-range variant.
  return labels.some((label) => /^0\d+$/.test(label) || label.length > 3 || Number(label) > 255);
}

export function inspectAddress(host: string): AddressVerdict {
  const raw = host
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (raw.length === 0) {
    return { blocked: true, kind: 'hostname', classification: 'invalid', reason: 'empty host' };
  }

  const v4 = parseIpv4(raw);
  if (v4) {
    const classification = classifyV4(v4);
    return {
      blocked: BLOCKED_CLASSIFICATIONS.has(classification),
      kind: 'ipv4',
      classification,
      reason: classification === 'public' ? 'public ipv4' : `${classification} ipv4 is not allowed`,
    };
  }

  if (raw.includes(':')) {
    const bytes = parseIpv6(raw);
    if (!bytes) {
      return {
        blocked: true,
        kind: 'ipv6',
        classification: 'invalid',
        reason: 'malformed IPv6 literal',
      };
    }
    const classification = isV6Metadata(bytes) ? 'cloud_metadata' : classifyV6Bytes(bytes);
    return {
      blocked: BLOCKED_CLASSIFICATIONS.has(classification),
      kind: 'ipv6',
      classification,
      reason: classification === 'public' ? 'public ipv6' : `${classification} ipv6 is not allowed`,
    };
  }

  if (looksLikeNonCanonicalIpLiteral(raw)) {
    return {
      blocked: true,
      kind: 'ipv4',
      classification: 'private',
      reason: 'non-canonical IP literal (octal, hex or abbreviated form) is not allowed',
    };
  }

  // Hostname: policy is applied after DNS resolution (see the worker's safe lookup).
  return {
    blocked: false,
    kind: 'hostname',
    classification: 'public',
    reason: 'hostname requires DNS check',
  };
}

export interface EndpointPolicyOptions {
  /** Escape hatch for local development/tests only (mock proxies on 127.0.0.1). */
  allowPrivate?: boolean;
  /** Extra literal addresses that are always allowed (exact match, dev/test only). */
  allow?: readonly string[];
}

/** Fast, DNS-free check of a literal host. Hostnames are always "allowed" here. */
export function isProxyEndpointAllowed(
  host: string,
  options: EndpointPolicyOptions = {},
): {
  ok: boolean;
  reason: string;
  classification: AddressClassification;
} {
  if (options.allow?.includes(host.replace(/^\[|\]$/g, ''))) {
    return { ok: true, reason: 'explicitly allowed', classification: 'public' };
  }
  const verdict = inspectAddress(host);
  if (!verdict.blocked)
    return { ok: true, reason: verdict.reason, classification: verdict.classification };
  if (options.allowPrivate && verdict.classification !== 'cloud_metadata') {
    return {
      ok: true,
      reason: `allowed by allowPrivate (${verdict.classification})`,
      classification: verdict.classification,
    };
  }
  return { ok: false, reason: verdict.reason, classification: verdict.classification };
}

/** Cloud metadata endpoint literals, checked separately so they stay blocked in dev mode. */
export const CLOUD_METADATA_HOSTS = [
  '169.254.169.254',
  '169.254.170.2',
  'metadata.google.internal',
  'metadata.goog',
  'fd00:ec2::254',
] as const;

export function isMetadataHostname(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    (CLOUD_METADATA_HOSTS as readonly string[]).includes(normalized) ||
    normalized.endsWith('.metadata.google.internal')
  );
}
