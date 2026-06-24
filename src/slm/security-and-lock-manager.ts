/**
 * Security and Lock Manager (SLM) subsystem.
 *
 * Keeps credentials and execution host-local, drives the Locked confidentiality
 * safe-state, and protects streamed context. Composes the Pairing Token
 * Authority, Host Authenticator, Lock State Controller, and Context Access Guard.
 * (FN-FN-020/021/022, ARC-REQ-006/007)
 */
import { BaseSubsystem, type RuntimeContext, type SubsystemHealth } from '../core/subsystem.js';
import { SERVICE } from '../core/services.js';
import type { Role } from '../core/constants.js';
import { TIMING } from '../core/constants.js';
import { PairingTokenAuthority } from './pairing-token-authority.js';
import { LockStateController } from './lock-state-controller.js';
import { HostAuthenticator } from './host-authenticator.js';
import { ContextAccessGuard } from './context-access-guard.js';
import { DEFAULT_ATTRIBUTE_ROLES } from '../ctx/role-scope-filter.js';

export class SecurityAndLockManager extends BaseSubsystem {
  readonly name = 'SecurityAndLockManager';

  readonly pta: PairingTokenAuthority;
  readonly lock: LockStateController;
  readonly authenticator: HostAuthenticator;
  readonly guard: ContextAccessGuard;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(ctx: RuntimeContext) {
    super(ctx);
    this.init();
    this.pta = new PairingTokenAuthority(this.log.child('pta'));
    this.lock = new LockStateController(this.bus, this.log.child('lock'));
    this.authenticator = new HostAuthenticator(this.log.child('auth'));
    this.guard = new ContextAccessGuard(this.log.child('guard'), (attr, role) => {
      const roles = DEFAULT_ATTRIBUTE_ROLES[attr];
      return Array.isArray(roles) && roles.includes(role);
    });
  }

  override async start(): Promise<void> {
    // OS lock events (or manual/API trigger) engage the safe-state.
    this.authenticator.watch((reason) => this.lock.engage(reason));

    // Periodically sweep expired pairing tokens.
    this.sweepTimer = setInterval(() => this.pta.sweep(), TIMING.TOKENS_SWEEP_MS).unref?.() as
      | NodeJS.Timeout
      | undefined;

    this.services.set(SERVICE.PairingTokenAuthority, this.pta);
    this.services.set(SERVICE.LockState, this.lock);
    this.services.set(SERVICE.ContextAccessGuard, this.guard);
    this.services.set(SERVICE.HostAuthenticator, this.authenticator);
    this.log.info('security and lock manager ready');
  }

  override async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.authenticator.unwatch();
  }

  override health(): SubsystemHealth {
    return { status: 'nominal', detail: { locked: this.lock.isLocked() } };
  }

  // --- Operator-facing API (used by the Admin Station / control endpoint) -------

  /** Engage the lock safe-state on demand. (FN-FN-020) */
  engageLock(reason = 'operator-command'): void {
    this.lock.engage(reason);
  }

  /** Re-authenticate at the host to resume from Locked. (FN-FN-021, SYS-REQ-003) */
  unlock(passphrase: string): boolean {
    if (!this.lock.isLocked()) return true;
    if (!this.authenticator.authenticate(passphrase)) return false;
    this.lock.release();
    return true;
  }

  /** Issue a signed session token after a successful pair. */
  issueSessionToken(fingerprint: string, role: Role): { token: string; expiresAt: number } {
    return this.pta.issueSessionToken(fingerprint, role);
  }
}
