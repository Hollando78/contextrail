/**
 * Crypto helpers: SHA-256 digests and high-entropy token generation.
 * Used for output digests (SUB-EXE-023, IFC-CTX-022) and pairing tokens
 * (SUB-PAIR-035, ≥ 128-bit entropy).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOKENS } from './constants.js';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Deterministic digest of an arbitrary JSON-serialisable value (stable key order). */
export function digestOf(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Generate a single-use token with at least the spec-mandated entropy. (SUB-PAIR-035) */
export function generateToken(bits: number = TOKENS.ENTROPY_BITS): string {
  const bytes = Math.ceil(bits / 8);
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison to avoid timing oracles on token checks. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Device fingerprint over stable client-supplied attributes. */
export function fingerprint(parts: Record<string, string>): string {
  return digestOf(parts);
}
