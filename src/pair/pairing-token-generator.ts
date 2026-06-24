/**
 * Pairing Token Generator (PAIR).
 *
 * Generates a cryptographically random single-use one-time token (OTT) with at
 * least 128 bits of entropy, suitable for encoding as a QR code, expiring after
 * 30 s if unused and invalidated immediately on first authenticated use. Only one
 * token is outstanding at a time. (SUB-PAIR-035, ARC-REQ-004)
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

export class PairingTokenGenerator {
  private outstanding: Outstanding | undefined;

  constructor(
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Issue a fresh OTT for an intended role, replacing any prior outstanding token. */
  issue(role: Role): { ott: string; expiresAt: number } {
    const ott = generateToken(TOKENS.ENTROPY_BITS);
    const expiresAt = this.now() + TOKENS.QR_TOKEN_TTL_MS;
    this.outstanding = { ott, role, expiresAt };
    this.log.info('issued pairing OTT', { role, ttlMs: TOKENS.QR_TOKEN_TTL_MS });
    return { ott, expiresAt };
  }

  /** Validate and consume an OTT. Returns the bound role, or null if invalid/expired. */
  consume(ott: string): Role | null {
    const o = this.outstanding;
    if (!o || o.ott !== ott) return null;
    if (this.now() > o.expiresAt) {
      this.outstanding = undefined;
      return null;
    }
    this.outstanding = undefined; // single-use: invalidate immediately
    return o.role;
  }

  hasOutstanding(): boolean {
    return !!this.outstanding && this.now() <= this.outstanding.expiresAt;
  }
}
