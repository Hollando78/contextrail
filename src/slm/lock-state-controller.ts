/**
 * Lock State Controller (SLM).
 *
 * The canonical lock-state machine. On a lock event it ceases context streaming
 * and begins rejecting inbound intents within 1 s, regardless of session count,
 * and holds the allowlist boundary. The Locked/Operational state change is
 * delivered synchronously within the same event-loop tick so no intent or
 * context message slips between the transition and downstream suspension.
 * (SUB-SLM-004, IFC-SLM-007, SYS-REQ-003, ARC-REQ-006)
 */
import type { EventBus } from '../core/bus.js';
import type { Logger } from '../core/logger.js';

export class LockStateController {
  private locked = false;

  constructor(
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  isLocked(): boolean {
    return this.locked;
  }

  /** Engage the lock safe-state. Idempotent. Emits lock:engaged synchronously. */
  engage(reason: string): void {
    if (this.locked) return;
    this.locked = true;
    const timestamp = new Date(this.now()).toISOString();
    // Synchronous emit (same tick) — subscribers suspend before control returns.
    this.bus.emit('lock:engaged', { reason, timestamp });
    this.log.warn('LOCK engaged', { reason });
  }

  /** Release the lock after successful host re-authentication. */
  release(): void {
    if (!this.locked) return;
    this.locked = false;
    const timestamp = new Date(this.now()).toISOString();
    this.bus.emit('lock:released', { timestamp });
    this.log.info('LOCK released');
  }
}
