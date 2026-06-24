/**
 * Allowlist and Configuration Governance (ACG) subsystem.
 *
 * Enforces the SSH/MCP/external action allowlist as a single default-deny gate,
 * governs allowlist edits (Maintenance-only), and audits every gate decision.
 * Composes the Policy Engine, Allowlist Store, Maintenance Configuration
 * Interface, and Allowlist Audit Logger. (FN-FN-018/019, ARC-REQ-003/008)
 */
import { BaseSubsystem, type RuntimeContext, type SubsystemHealth } from '../core/subsystem.js';
import { SERVICE } from '../core/services.js';
import { TIMING } from '../core/constants.js';
import { dataPaths } from '../core/paths.js';
import { AllowlistStore } from './allowlist-store.js';
import { AllowlistAuditLogger } from './allowlist-audit-logger.js';
import { PolicyEngine } from './policy-engine.js';
import { MaintenanceConfigurationInterface } from './maintenance-configuration-interface.js';

export class AllowlistAndConfigurationGovernance extends BaseSubsystem {
  readonly name = 'AllowlistAndConfigurationGovernance';

  readonly store: AllowlistStore;
  readonly audit: AllowlistAuditLogger;
  readonly policy: PolicyEngine;
  readonly maintenance: MaintenanceConfigurationInterface;
  private sweepTimer: NodeJS.Timeout | undefined;
  private readonly offs: Array<() => void> = [];

  constructor(ctx: RuntimeContext) {
    super(ctx);
    this.init();
    const paths = dataPaths(this.config.dataDir);
    this.store = new AllowlistStore(paths.allowlist, this.log.child('store'));
    this.audit = new AllowlistAuditLogger(paths.allowlistAudit, this.log.child('audit'));
    this.policy = new PolicyEngine(this.store, this.audit, this.log.child('policy'));
    this.maintenance = new MaintenanceConfigurationInterface(this.store, this.log.child('maint'));
  }

  override async start(): Promise<void> {
    await this.store.load();
    this.offs.push(this.bus.on('mode:changed', (m) => this.maintenance.setMode(m.to)));
    this.sweepTimer = setInterval(() => this.policy.sweep(), TIMING.TOKENS_SWEEP_MS);
    this.sweepTimer.unref?.();

    this.services.set(SERVICE.PolicyEngine, this.policy);
    this.services.set(SERVICE.AllowlistStore, this.store);
    this.services.set(SERVICE.MaintenanceConfig, this.maintenance);
    this.log.info('allowlist & configuration governance ready', { entries: this.store.list().length });
  }

  override async stop(): Promise<void> {
    for (const off of this.offs.splice(0)) off();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  override health(): SubsystemHealth {
    return { status: 'nominal', detail: { entries: this.store.list().length } };
  }
}
