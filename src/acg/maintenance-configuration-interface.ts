/**
 * Maintenance Configuration Interface (ACG).
 *
 * The only path to mutate the allowlist, and only while the host is in
 * Maintenance mode; add/remove/list are rejected with an explicit MODE_RESTRICTION
 * error in any other mode. Changes never expose the allowlist surface to a
 * desklet. (SUB-ACG-009, SUB-HAS-067, SYS-REQ-005, IFC-ACG-010, IFC-HAS-055)
 */
import type { Logger } from '../core/logger.js';
import type { Mode } from '../core/constants.js';
import type { AllowlistEntry } from '../core/types.js';
import { ContextRailError } from '../core/errors.js';
import type { AllowlistStore } from './allowlist-store.js';

export class MaintenanceConfigurationInterface {
  private mode: Mode = 'Initialising';

  constructor(
    private readonly store: AllowlistStore,
    private readonly log: Logger,
  ) {}

  /** Track the host mode (driven by HCR mode:changed). (IFC-ACG-010) */
  setMode(mode: Mode): void {
    this.mode = mode;
  }

  private requireMaintenance(op: string): void {
    if (this.mode !== 'Maintenance') {
      throw new ContextRailError('MODE_RESTRICTION', `allowlist ${op} is only permitted in Maintenance mode`, {
        currentMode: this.mode,
      });
    }
  }

  async add(entry: AllowlistEntry, operatorSession: string): Promise<void> {
    this.requireMaintenance('add');
    await this.store.add(entry);
    this.log.info('allowlist entry added', { entry, operatorSession });
  }

  async remove(adapter: string, actionPattern: string, operatorSession: string): Promise<boolean> {
    this.requireMaintenance('remove');
    const ok = await this.store.remove(adapter, actionPattern);
    this.log.info('allowlist entry removed', { adapter, actionPattern, ok, operatorSession });
    return ok;
  }

  list(): AllowlistEntry[] {
    this.requireMaintenance('list');
    return this.store.list();
  }
}
