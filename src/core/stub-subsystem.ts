/**
 * Placeholder subsystem for boot roots not yet implemented. It signals READY and
 * reports nominal health so the host can boot end-to-end while subsystems are
 * filled in one at a time. Each stub is replaced by its real implementation as
 * the build progresses; the log line makes the stubbing explicit and honest.
 */
import { BaseSubsystem, type RuntimeContext, type SubsystemHealth } from './subsystem.js';

export class StubSubsystem extends BaseSubsystem {
  readonly name: string;

  constructor(ctx: RuntimeContext, name: string) {
    super(ctx);
    this.name = name;
    this.init();
  }

  override async start(): Promise<void> {
    this.log.warn('STUB subsystem started (not yet implemented)', { subsystem: this.name });
  }

  override async stop(): Promise<void> {
    /* nothing to release */
  }

  override health(): SubsystemHealth {
    return { status: 'nominal', detail: { stub: true } };
  }
}
