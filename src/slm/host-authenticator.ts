/**
 * Host Authenticator (SLM).
 *
 * Detects OS session-lock events and signals the Lock State Controller, and
 * authenticates the host operator to resume from Locked. (SUB-SLM-003,
 * FN-FN-021, IFC-SLM-006)
 *
 * OS-native lock detection is platform-specific (e.g. systemd-logind DBus on
 * Linux, session notifications on Windows). It is modelled here as a pluggable
 * detector; the default is a manual trigger (operator locks via the Admin
 * Station / API), which is always available and offline. The operator credential
 * is a host-resident passphrase hash (env `CONTEXTRAIL_OPERATOR_HASH`, a SHA-256
 * hex of the passphrase) — credentials never leave the host. (SYS-REQ-001)
 */
import type { Logger } from '../core/logger.js';
import { sha256Hex, safeEqual } from '../core/crypto.js';

export interface LockEventDetector {
  /** Begin watching for OS lock events; invoke `onLock` when one occurs. */
  start(onLock: (reason: string) => void): void;
  stop(): void;
}

/** Default no-op detector: relies on explicit operator/API lock triggers. */
class ManualLockDetector implements LockEventDetector {
  start(): void {
    /* manual trigger only */
  }
  stop(): void {
    /* nothing */
  }
}

export class HostAuthenticator {
  private readonly detector: LockEventDetector;
  private readonly operatorHash: string | undefined;

  constructor(
    private readonly log: Logger,
    detector?: LockEventDetector,
  ) {
    this.detector = detector ?? new ManualLockDetector();
    this.operatorHash = process.env['CONTEXTRAIL_OPERATOR_HASH'];
    if (!this.operatorHash) {
      // Dev default passphrase "contextrail" so the lock/unlock flow is usable
      // out of the box; production deployments must set the env var.
      this.operatorHash = sha256Hex('contextrail');
      this.log.warn('using default operator passphrase — set CONTEXTRAIL_OPERATOR_HASH in production');
    }
  }

  watch(onLock: (reason: string) => void): void {
    this.detector.start((reason) => {
      this.log.warn('OS lock event detected', { reason });
      onLock(reason);
    });
  }

  unwatch(): void {
    this.detector.stop();
  }

  /** Verify an operator passphrase to resume from Locked. (FN-FN-021) */
  authenticate(passphrase: string): boolean {
    const ok = safeEqual(sha256Hex(passphrase), this.operatorHash ?? '');
    this.log.info('operator authentication attempt', { ok });
    return ok;
  }
}
