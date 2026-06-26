/**
 * Pairing Token Generator (PAIR).
 *
 * Generates cryptographically random single-use one-time tokens (OTTs) with at
 * least 128 bits of entropy, suitable for encoding as a QR code, expiring after a
 * short TTL if unused and invalidated immediately on first authenticated use.
 * (SUB-PAIR-035, ARC-REQ-004)
 *
 * A small bounded ring of recent tokens is kept (rather than exactly one) so the
 * operator console can refresh the displayed QR without invalidating a code a
 * phone has *just* scanned but not yet redeemed — that single-outstanding race
 * was the cause of "page loads, then pairing fails". Security is preserved: every
 * token is still single-use and expires within the TTL.
 */
import type { Logger } from '../core/logger.js';
import type { Role } from '../core/constants.js';
import { TOKENS } from '../core/constants.js';
import { generateToken } from '../core/crypto.js';

interface Outstanding {
  ott: string;
  role: Role;
  expiresAt: number;
}

/** How many recently-issued OTTs may be redeemable at once (bounded ring). */
const MAX_OUTSTANDING = 8;

export class PairingTokenGenerator {
  private readonly outstanding = new Map<string, Outstanding>();

  constructor(
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Issue a fresh OTT for an intended role. Prior unredeemed tokens remain valid
   *  until their own TTL (so a QR refresh doesn't strand an in-flight scan). */
  issue(role: Role): { ott: string; expiresAt: number } {
    this.prune();
    const ott = generateToken(TOKENS.ENTROPY_BITS);
    const expiresAt = this.now() + TOKENS.QR_TOKEN_TTL_MS;
    this.outstanding.set(ott, { ott, role, expiresAt });
    // Bound the ring: drop the oldest beyond the cap (Map preserves insertion order).
    while (this.outstanding.size > MAX_OUTSTANDING) {
      const oldest = this.outstanding.keys().next().value;
      if (oldest === undefined) break;
      this.outstanding.delete(oldest);
    }
    this.log.info('issued pairing OTT', { role, ttlMs: TOKENS.QR_TOKEN_TTL_MS, outstanding: this.outstanding.size });
    return { ott, expiresAt };
  }

  /** Validate and consume an OTT. Returns the bound role, or null if invalid/expired. */
  consume(ott: string): Role | null {
    const o = this.outstanding.get(ott);
    if (!o) return null;
    this.outstanding.delete(ott); // single-use: invalidate immediately
    if (this.now() > o.expiresAt) return null;
    return o.role;
  }

  hasOutstanding(): boolean {
    this.prune();
    return this.outstanding.size > 0;
  }

  /** Drop expired tokens so the ring reflects only redeemable codes. */
  private prune(): void {
    const now = this.now();
    for (const [ott, o] of this.outstanding) if (now > o.expiresAt) this.outstanding.delete(ott);
  }
}
