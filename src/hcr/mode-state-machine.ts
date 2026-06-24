/**
 * Mode State Machine (HCR).
 *
 * SUB-HCR-016 fixes a three-state operational model — Nominal, Degraded,
 * Maintenance — and requires undefined transitions to be rejected and logged.
 * The ConOps adds two non-operational overlays: `Initialising` (boot phase,
 * exited on BOOT_COMPLETE) and `Locked` (a confidentiality safe-state driven by
 * the Security and Lock Manager, ARC-REQ-006). We model the union here; the MSM
 * owns the operational transitions and records the lock overlay so a single
 * authority reports the host mode.
 *
 * On SUBSYSTEM_FAILED the machine broadcasts MODE_DEGRADED within 500 ms
 * (synchronously, well inside budget) carrying the failed subsystem identity.
 * (SUB-HCR-017)
 */
import type { EventBus } from '../core/bus.js';
import type { Logger } from '../core/logger.js';
import type { Mode } from '../core/constants.js';

/** Allowed operational transitions, plus boot and lock overlays. */
const TRANSITIONS: Record<Mode, ReadonlySet<Mode>> = {
  Initialising: new Set<Mode>(['Nominal', 'Maintenance']),
  Nominal: new Set<Mode>(['Degraded', 'Maintenance', 'Locked']),
  Degraded: new Set<Mode>(['Nominal', 'Maintenance', 'Locked']),
  Maintenance: new Set<Mode>(['Nominal', 'Degraded']),
  Locked: new Set<Mode>(['Nominal', 'Degraded']), // resume after re-auth (SYS-REQ-003)
};

export class ModeStateMachine {
  private current: Mode = 'Initialising';
  /** Mode to restore to when the lock overlay is released. */
  private preLockMode: Mode = 'Nominal';

  constructor(
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {
    // The lock overlay is owned by the SLM; the MSM records it so `mode()` is authoritative.
    this.bus.on('lock:engaged', () => this.transition('Locked', 'lock-engaged'));
    this.bus.on('lock:released', () => this.transition(this.preLockMode, 'lock-released'));
    this.bus.on('subsystem:failed', (p) => this.onSubsystemFailed(p.subsystem));
    this.bus.on('subsystem:recovered', () => this.onSubsystemRecovered());
  }

  mode(): Mode {
    return this.current;
  }

  /** Attempt a transition. Undefined transitions are rejected and logged. (SUB-HCR-016) */
  transition(to: Mode, trigger: string): boolean {
    if (to === this.current) return true;
    const allowed = TRANSITIONS[this.current];
    if (!allowed.has(to)) {
      this.log.warn('rejected mode transition', { from: this.current, to, trigger });
      return false;
    }
    const from = this.current;
    if (to === 'Locked') this.preLockMode = from === 'Locked' ? this.preLockMode : from;
    this.current = to;
    this.log.info('mode transition', { from, to, trigger });
    this.bus.emit('mode:changed', { from, to, reason: trigger });
    return true;
  }

  /** Called by the Startup Orchestrator once all subsystems report READY. (IFC-HCR-015) */
  bootComplete(): void {
    this.transition('Nominal', 'BOOT_COMPLETE');
  }

  private onSubsystemFailed(subsystem: string): void {
    // Don't override the Locked safe-state with Degraded.
    if (this.current === 'Locked' || this.current === 'Maintenance') {
      this.log.warn('subsystem failed while in overlay mode', { subsystem, mode: this.current });
      return;
    }
    if (this.transition('Degraded', `SUBSYSTEM_FAILED:${subsystem}`)) {
      this.log.warn('MODE_DEGRADED', { subsystem });
    }
  }

  private onSubsystemRecovered(): void {
    if (this.current === 'Degraded') {
      this.transition('Nominal', 'SUBSYSTEM_RECOVERED');
    }
  }
}
