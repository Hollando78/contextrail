/**
 * Host Administration Station (HAS) subsystem.
 *
 * The operator's control surface: Mode Control (Maintenance), Allowlist
 * Management, Audit Log Viewer, and Host Credential Validator — all host-local
 * over the loopback admin API. Registers the admin handler the Local Transport
 * Server delegates loopback /admin/* requests to. (FN-FN-019, SUB-HAS-067/073)
 */
import { BaseSubsystem, type RuntimeContext, type SubsystemHealth } from '../core/subsystem.js';
import { SERVICE, type ModeControl } from '../core/services.js';
import type { MaintenanceConfigurationInterface } from '../acg/maintenance-configuration-interface.js';
import type { LockStateController } from '../slm/lock-state-controller.js';
import type { HostAuthenticator } from '../slm/host-authenticator.js';
import type { DeviceIdentityLedger } from '../pair/device-identity-ledger.js';
import { HostAdminApi } from './admin-api.js';

export class HostAdministrationStation extends BaseSubsystem {
  readonly name = 'HostAdministrationStation';

  constructor(ctx: RuntimeContext) {
    super(ctx);
    this.init();
  }

  override async start(): Promise<void> {
    const api = new HostAdminApi({
      modeControl: this.services.get<ModeControl>(SERVICE.ModeControl),
      maintenance: this.services.get<MaintenanceConfigurationInterface>(SERVICE.MaintenanceConfig),
      lock: this.services.get<LockStateController>(SERVICE.LockState),
      authenticator: this.services.get<HostAuthenticator>(SERVICE.HostAuthenticator),
      ledger: this.services.get<DeviceIdentityLedger>(SERVICE.DeviceLedger),
      dataDir: this.config.dataDir,
      log: this.log.child('api'),
    });
    this.services.set(SERVICE.AdminApi, api);
    this.log.info('host administration station ready (loopback /admin/*)');
  }

  override async stop(): Promise<void> {
    /* nothing to release */
  }

  override health(): SubsystemHealth {
    return { status: 'nominal' };
  }
}
