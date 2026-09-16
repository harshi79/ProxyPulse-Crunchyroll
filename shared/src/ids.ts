/**
 * Identifier helpers, a non-cryptographic bucket hash and a constant-time-ish string comparison.
 * Uses only Web APIs (globalThis.crypto, TextEncoder) so it works in Node.js and Cloudflare Workers.
 */

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function newRequestId(prefix = 'req'): string {
  return `${prefix}_${randomHex(8)}`;
}

export function newJobId(prefix = 'job'): string {
  return `${prefix}_${randomHex(8)}`;
}

/** Cycle ids sort chronologically: `cyc_<utc timestamp>_<random>`. */
export function newCycleId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `cyc_${stamp}_${randomHex(4)}`;
}

/** 32bit FNV-1a. Only used for bucketing/cache keys, never as a security primitive. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function fnv1a32Hex(input: string): string {
  return fnv1a32(input).toString(16).padStart(8, '0');
}

export function bucketOf(input: string, buckets: number): number {
  if (buckets <= 1) return 0;
  return fnv1a32(input) % buckets;
}

/**
 * Compares two secrets without leaking their length-prefix in the common case.
 * (TimingSafeEqual is not available as a global; for a public API key check this is sufficient and
 * the API key is additionally rate limited.)
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    difference |= (left[i % (left.length || 1)] ?? 0) ^ (right[i % (right.length || 1)] ?? 0);
  }
  return difference === 0 && left.length === right.length;
}

export const isoNow = (now: () => number = () => Date.now()): string =>
  new Date(now()).toISOString();
