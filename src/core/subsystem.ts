/**
 * Subsystem contract. Every top-level subsystem implements this so the Startup
 * Orchestrator can boot them in order and the Health Watchdog can poll them.
 * (SUB-HCR-018, SUB-HCR-019)
 */
import type { EventBus } from './bus.js';
import type { Logger } from './logger.js';
import type { HostConfig } from './config.js';
import type { ServiceRegistry } from './services.js';

export type HealthStatus = 'nominal' | 'degraded' | 'unavailable';

export interface SubsystemHealth {
  status: HealthStatus;
  detail?: Record<string, unknown>;
}

/** Shared services handed to each subsystem at construction. */
export interface RuntimeContext {
  bus: EventBus;
  config: HostConfig;
  logger: Logger;
  /** Absolute path to the runtime data directory (ledger, allowlist, audit). */
  dataDir: string;
  /** Cross-subsystem in-process service registry. */
  services: ServiceRegistry;
}

export interface Subsystem {
  /** Stable identifier matching BOOT_ORDER / health registry. */
  readonly name: string;
  /** Start the subsystem; resolve once READY. Reject => BOOT_FAILED. (SUB-HCR-019) */
  start(): Promise<void>;
  /** Stop the subsystem and release resources. */
  stop(): Promise<void>;
  /** Current health, polled by the Health Watchdog. (IFC-XPT-020) */
  health(): SubsystemHealth;
}

/** Convenience base that wires the common runtime context and a scoped logger. */
export abstract class BaseSubsystem implements Subsystem {
  abstract readonly name: string;
  protected readonly bus: EventBus;
  protected readonly config: HostConfig;
  protected readonly dataDir: string;
  protected readonly services: ServiceRegistry;
  protected log!: Logger;
  private readonly ctx: RuntimeContext;

  constructor(ctx: RuntimeContext) {
    this.ctx = ctx;
    this.bus = ctx.bus;
    this.config = ctx.config;
    this.dataDir = ctx.dataDir;
    this.services = ctx.services;
  }

  protected init(): void {
    // Deferred so `this.name` (set in subclass field initialiser) is available.
    this.log = this.ctx.logger.child(this.name);
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  health(): SubsystemHealth {
    return { status: 'nominal' };
  }
}
