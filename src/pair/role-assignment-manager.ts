/**
 * Role Assignment Manager (PAIR).
 *
 * Binds each paired desklet to exactly one role drawn from {Project, Actions,
 * Status, Capture, Logs, AI}; rejects any out-of-set role with a typed error.
 * (SUB-PAIR-037, SYS-REQ-007)
 */
import type { Logger } from '../core/logger.js';
import { ROLES, isRole, type Role } from '../core/constants.js';
import { ContextRailError } from '../core/errors.js';

export class RoleAssignmentManager {
  private readonly bindings = new Map<string, Role>();

  constructor(private readonly log: Logger) {}

  /** Validate + record a single-role binding. Throws ROLE_OUT_OF_SET if invalid. */
  assign(deviceId: string, role: string): Role {
    if (!isRole(role)) {
      throw new ContextRailError('ROLE_OUT_OF_SET', `role '${role}' is not in the permitted set`, {
        permitted: ROLES,
      });
    }
    this.bindings.set(deviceId, role);
    this.log.info('assigned role', { deviceId, role });
    return role;
  }

  roleOf(deviceId: string): Role | undefined {
    return this.bindings.get(deviceId);
  }

  /** True if the device's bound role permits the given intent role scope. (SYS-REQ-007) */
  permits(deviceId: string, role: Role): boolean {
    return this.bindings.get(deviceId) === role;
  }

  release(deviceId: string): void {
    this.bindings.delete(deviceId);
  }
}
