/**
 * Startup Orchestrator (HCR).
 *
 * Starts subsystems strictly in the boot order (SUB-HCR-019); each must signal
 * READY within 5 s of being started or boot aborts with BOOT_FAILED. The whole
 * sequence must complete within 30 s, after which BOOT_COMPLETE is the sole
 * trigger to enter Nominal. (IFC-HCR-015, IFC-HCR-016)
 */
import type { EventBus } from '../core/bus.js';
import type { Logger } from '../core/logger.js';
import type { Subsystem } from '../core/subsystem.js';
import { TIMING } from '../core/constants.js';
import { ContextRailError } from '../core/errors.js';

/** Run a promise against a deadline, rejecting with BOOT_FAILED on timeout. */
function withDeadline<T>(p: Promise<T>, ms: number, subsystem: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ContextRailError('BOOT_FAILED', `${subsystem} did not signal READY within ${ms}ms`, {
          subsystem,
        }),
      );
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class StartupOrchestrator {
  private readonly started: Subsystem[] = [];

  constructor(
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  /** Boot the ordered subsystems. Returns the started names on success. */
  async boot(ordered: Subsystem[]): Promise<string[]> {
    const overall = setTimeout(() => {
      this.log.error('boot exceeded overall deadline', { deadlineMs: TIMING.BOOT_DEADLINE_MS });
    }, TIMING.BOOT_DEADLINE_MS);

    try {
      for (const sub of ordered) {
        this.log.info('starting subsystem', { subsystem: sub.name });
        try {
          await withDeadline(sub.start(), TIMING.SUBSYSTEM_READY_MS, sub.name);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.bus.emit('boot:failed', { subsystem: sub.name, reason });
          this.log.error('BOOT_FAILED', { subsystem: sub.name, reason });
          await this.rollback();
          throw err instanceof ContextRailError
            ? err
            : new ContextRailError('BOOT_FAILED', reason, { subsystem: sub.name });
        }
        this.started.push(sub);
        this.log.info('subsystem READY', { subsystem: sub.name });
      }

      const names = this.started.map((s) => s.name);
      this.bus.emit('boot:complete', { subsystems: names });
      this.log.info('BOOT_COMPLETE', { subsystems: names });
      return names;
    } finally {
      clearTimeout(overall);
    }
  }

  /** Stop already-started subsystems in reverse order on a failed boot. */
  private async rollback(): Promise<void> {
    for (const sub of [...this.started].reverse()) {
      try {
        await sub.stop();
      } catch (err) {
        this.log.warn('rollback stop failed', { subsystem: sub.name, err: (err as Error).message });
      }
    }
    this.started.length = 0;
  }

  /** Ordered shutdown (reverse boot order). */
  async shutdown(): Promise<void> {
    for (const sub of [...this.started].reverse()) {
      try {
        await sub.stop();
        this.log.info('subsystem stopped', { subsystem: sub.name });
      } catch (err) {
        this.log.warn('stop failed', { subsystem: sub.name, err: (err as Error).message });
      }
    }
    this.started.length = 0;
  }
}
