/**
 * Host Core Runtime (HCR).
 *
 * Owns the Mode State Machine, Health Watchdog, and Startup Orchestrator, and
 * drives host startup and the operational-mode lifecycle. (FN-FN-017,
 * SUB-HCR-016..020) It boots the ordered subsystems, registers them with the
 * watchdog, and on BOOT_COMPLETE drives the transition to Nominal.
 */
import type { EventBus } from '../core/bus.js';
import type { Logger } from '../core/logger.js';
import type { Subsystem } from '../core/subsystem.js';
import type { Mode } from '../core/constants.js';
import { ModeStateMachine } from './mode-state-machine.js';
import { HealthWatchdog } from './health-watchdog.js';
import { StartupOrchestrator } from './startup-orchestrator.js';

export class HostCoreRuntime {
  readonly modes: ModeStateMachine;
  private readonly watchdog: HealthWatchdog;
  private readonly orchestrator: StartupOrchestrator;
  private readonly log: Logger;

  constructor(
    private readonly bus: EventBus,
    logger: Logger,
  ) {
    this.log = logger.child('HostCoreRuntime');
    this.modes = new ModeStateMachine(bus, this.log.child('mode'));
    this.watchdog = new HealthWatchdog(bus, this.log.child('watchdog'));
    this.orchestrator = new StartupOrchestrator(bus, this.log.child('startup'));
  }

  mode(): Mode {
    return this.modes.mode();
  }

  /** Boot all subsystems in order, then enter Nominal and start health polling. */
  async boot(ordered: Subsystem[]): Promise<void> {
    const names = await this.orchestrator.boot(ordered);
    for (const sub of ordered) this.watchdog.register(sub);
    this.modes.bootComplete();
    this.watchdog.start();
    this.log.info('host operational', { mode: this.mode(), subsystems: names });
  }

  /** Enter or leave Maintenance mode (operator-driven). */
  enterMaintenance(): boolean {
    return this.modes.transition('Maintenance', 'maintenance-command');
  }

  leaveMaintenance(): boolean {
    return this.modes.transition('Nominal', 'maintenance-complete');
  }

  async shutdown(): Promise<void> {
    this.watchdog.stop();
    await this.orchestrator.shutdown();
    this.log.info('host shut down');
  }
}
