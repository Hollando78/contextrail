/**
 * Role Scope Filter (CTX).
 *
 * The single choke point for per-role context boundaries (ARC-REQ-012). Produces
 * a deterministic role-scoped projection: only attributes tagged with the
 * requesting role are included, plus a SHA-256 digest of the full current
 * attribute set for that role. (SUB-CTX-031, IFC-CTX-022, SYS-REQ-011)
 */
import type { Role } from '../core/constants.js';
import type { ContextObject, RoleProjection } from '../core/types.js';
import { digestOf } from '../core/crypto.js';

/**
 * Default classification of well-known workspace attributes to roles. Attributes
 * may also carry explicit role tags; this map is the deterministic fallback used
 * when the Event Bus Adapter writes a known attribute without explicit tags.
 */
export const DEFAULT_ATTRIBUTE_ROLES: Record<string, Role[]> = {
  activeProject: ['Project', 'Status', 'Actions'],
  openTools: ['Project', 'Status'],
  windowLayout: ['Project'],
  toolStatus: ['Status'],
  health: ['Status'],
  hostMode: ['Status', 'Project', 'Actions', 'Capture', 'Logs', 'AI'],
  pairedDevices: ['Status', 'Project'],
  lastOutcome: ['Status', 'Logs'],
  commandHistory: ['Logs'],
  logs: ['Logs'],
  availableActions: ['Actions'],
  commandProfiles: ['Actions'],
  captures: ['Capture'],
  notes: ['Capture'],
  aiContext: ['AI'],
  aiSuggestions: ['AI'],
};

export class RoleScopeFilter {
  /** Roles permitted to see a given attribute, falling back to the default map. */
  rolesFor(attributeName: string, explicit?: Role[]): Role[] {
    if (explicit && explicit.length) return explicit;
    return DEFAULT_ATTRIBUTE_ROLES[attributeName] ?? [];
  }

  /** The full current attribute set visible to `role` across all context objects. */
  roleAttributeSet(objects: Iterable<ContextObject>, role: Role): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const obj of objects) {
      for (const [name, attr] of Object.entries(obj.attributes)) {
        if (attr.roles.includes(role)) out[`${obj.id}.${name}`] = attr.value;
      }
    }
    return out;
  }

  /**
   * Build a role projection for a delta against a context object. Returns null if
   * none of the delta fields are visible to the role (nothing to stream).
   */
  project(
    deskletId: string,
    role: Role,
    obj: ContextObject,
    deltaFieldNames: string[],
    allObjects: Iterable<ContextObject>,
    stale: boolean,
  ): RoleProjection | null {
    const deltaFields: Record<string, unknown> = {};
    let anyStale = stale;
    for (const name of deltaFieldNames) {
      const attr = obj.attributes[name];
      if (attr && attr.roles.includes(role)) {
        deltaFields[name] = attr.value;
        if (attr.stale) anyStale = true;
      }
    }
    if (Object.keys(deltaFields).length === 0) return null;

    return {
      deskletId,
      role,
      contextObjectId: obj.id,
      deltaFields,
      version: obj.version,
      digest: digestOf(this.roleAttributeSet(allObjects, role)),
      stale: anyStale,
    };
  }

  /** A full snapshot projection for a role (used for the initial frame on join). */
  snapshot(deskletId: string, role: Role, allObjects: Iterable<ContextObject>, stale: boolean): RoleProjection {
    const set = this.roleAttributeSet(allObjects, role);
    return {
      deskletId,
      role,
      contextObjectId: '*',
      deltaFields: set,
      version: 0,
      digest: digestOf(set),
      stale,
    };
  }
}
