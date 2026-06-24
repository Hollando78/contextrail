/**
 * Pairing Token Authority (SLM).
 *
 * Issues cryptographically unique, single-use session tokens bound to a device
 * fingerprint and expiring within 60 s if unredeemed; validates tokens and
 * rejects unrecognised / already-redeemed / expired ones with a logged reason.
 * (SUB-SLM-001, SUB-SLM-002, IFC-SLM-005, IFC-PAIR-028, ARC-REQ-004)
 *
 * Tokens are HMAC-signed with a per-process secret so a forged token never
 * validates even before the in-memory record is consulted.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { Logger } from '../core/logger.js';
import type { Role } from '../core/constants.js';
import { TOKENS } from '../core/constants.js';
import { generateToken, safeEqual } from '../core/crypto.js';
import { ContextRailError, type ReasonCode } from '../core/errors.js';

interface TokenRecord {
  fingerprint: string;
  role: Role;
  expiresAt: number;
  redeemed: boolean;
}

export interface TokenValidation {
  valid: boolean;
  role?: Role;
  expiry?: number;
  reason?: ReasonCode;
}

export class PairingTokenAuthority {
  private readonly secret = randomBytes(32);
  private readonly records = new Map<string, TokenRecord>();

  constructor(
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Issue a signed single-use session token bound to a fingerprint + role. */
  issueSessionToken(fingerprint: string, role: Role): { token: string; expiresAt: number } {
    const nonce = generateToken(TOKENS.ENTROPY_BITS);
    const expiresAt = this.now() + TOKENS.PAIRING_TTL_MS;
    const body = `${nonce}.${expiresAt}`;
    const sig = this.sign(body);
    const token = `${body}.${sig}`;
    this.records.set(token, { fingerprint, role, expiresAt, redeemed: false });
    this.log.info('issued session token', { role, ttlMs: TOKENS.PAIRING_TTL_MS });
    return { token, expiresAt };
  }

  /**
   * Validate a token for a fingerprint. Single-use: a valid token is marked
   * redeemed so it cannot admit a second connection (SUB-SLM-001/002). Rejections
   * are logged with the fingerprint + timestamp.
   */
  validate(token: string, fingerprint: string): TokenValidation {
    const reject = (reason: ReasonCode): TokenValidation => {
      this.log.warn('token rejected', { reason, fingerprint, at: new Date(this.now()).toISOString() });
      return { valid: false, reason };
    };

    const parts = token.split('.');
    if (parts.length !== 3 || !this.verifySignature(token)) return reject('TOKEN_UNRECOGNISED');

    const record = this.records.get(token);
    if (!record) return reject('TOKEN_UNRECOGNISED');
    if (this.now() > record.expiresAt) {
      this.records.delete(token);
      return reject('TOKEN_EXPIRED');
    }
    if (record.redeemed) return reject('TOKEN_ALREADY_CONSUMED');
    if (!safeEqual(record.fingerprint, fingerprint)) return reject('FINGERPRINT_MISMATCH');

    record.redeemed = true;
    return { valid: true, role: record.role, expiry: record.expiresAt };
  }

  /** Validate without consuming — used by the transport to peek before upgrade. */
  peek(token: string, fingerprint: string): TokenValidation {
    if (token.split('.').length !== 3 || !this.verifySignature(token)) {
      return { valid: false, reason: 'TOKEN_UNRECOGNISED' };
    }
    const record = this.records.get(token);
    if (!record) return { valid: false, reason: 'TOKEN_UNRECOGNISED' };
    if (this.now() > record.expiresAt) return { valid: false, reason: 'TOKEN_EXPIRED' };
    if (record.redeemed) return { valid: false, reason: 'TOKEN_ALREADY_CONSUMED' };
    if (!safeEqual(record.fingerprint, fingerprint)) return { valid: false, reason: 'FINGERPRINT_MISMATCH' };
    return { valid: true, role: record.role, expiry: record.expiresAt };
  }

  /** Periodic sweep of expired unredeemed tokens (defence in depth). */
  sweep(): void {
    const now = this.now();
    for (const [token, rec] of this.records) {
      if (now > rec.expiresAt) this.records.delete(token);
    }
  }

  requireValid(token: string, fingerprint: string): { role: Role } {
    const v = this.validate(token, fingerprint);
    if (!v.valid || !v.role) {
      throw new ContextRailError(v.reason ?? 'TOKEN_UNRECOGNISED', 'token validation failed', {
        fingerprint,
      });
    }
    return { role: v.role };
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }

  private verifySignature(token: string): boolean {
    const idx = token.lastIndexOf('.');
    if (idx <= 0) return false;
    const body = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    return safeEqual(this.sign(body), sig);
  }
}
