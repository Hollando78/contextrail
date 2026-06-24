/**
 * Health Watchdog (HCR).
 *
 * Polls each registered subsystem's health at 2 s ± 100 ms and triggers
 * SUBSYSTEM_FAILED after 2 consecutive missed/poor heartbeats (total detection
 * window ≤ 5 s). Polling runs on its own timer, decoupled from the hot path, so
 * the detection budget is met regardless of event-loop load. (SUB-HCR-018,
 * IFC-HCR-014, ARC-REQ-010)
 */
import type { EventBus } from '../core/bus.js';
import type { Logger } from '../core/logger.js';
import type { Subsystem } from '../core/subsystem.js';
import { TIMING } from '../core/constants.js';

const MISSES_BEFORE_FAILED = 2;

export class HealthWatchdog {
  private readonly subsystems = new Map<string, Subsystem>();
  private readonly misses = new Map<string, number>();
  private readonly failed = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  register(subsystem: Subsystem): void {
    this.subsystems.set(subsystem.name, subsystem);
    this.misses.set(subsystem.name, 0);
  }

  start(): void {
    const schedule = () => {
      const jitter = (Math.random() * 2 - 1) * TIMING.HEALTH_POLL_JITTER_MS;
      this.timer = setTimeout(() => {
        this.poll();
        schedule();
      }, TIMING.HEALTH_POLL_INTERVAL_MS + jitter);
    };
    schedule();
    this.log.info('health watchdog started', { intervalMs: TIMING.HEALTH_POLL_INTERVAL_MS });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private poll(): void {
    const timestamp = new Date().toISOString();
    for (const [name, sub] of this.subsystems) {
      let healthy = false;
      try {
        const h = sub.health();
        healthy = h.status === 'nominal' || h.status === 'degraded';
      } catch (err) {
        this.log.error('health() threw', { subsystem: name, err: (err as Error).message });
      }

      if (healthy) {
        this.misses.set(name, 0);
        if (this.failed.delete(name)) {
          this.bus.emit('subsystem:recovered', { subsystem: name, timestamp });
          this.log.info('subsystem recovered', { subsystem: name });
        }
        continue;
      }

      const next = (this.misses.get(name) ?? 0) + 1;
      this.misses.set(name, next);
      if (next >= MISSES_BEFORE_FAILED && !this.failed.has(name)) {
        this.failed.add(name);
        this.bus.emit('subsystem:failed', { subsystem: name, timestamp });
        this.log.warn('subsystem failed', { subsystem: name, missed: next });
      }
    }
  }
}
