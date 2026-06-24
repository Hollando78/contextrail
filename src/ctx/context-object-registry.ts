/**
 * Context Object Registry (CTX).
 *
 * Maintains the single authoritative in-memory snapshot of the active workspace
 * — open tool identifiers, window layout, active project reference, the last 50
 * command-history entries, and per-tool status indicators. Writes apply within
 * 50 ms (trivially, in-process). (SUB-CTX-030, ARC-REQ-012, IFC-CTX-033/034)
 */
import type { Role } from '../core/constants.js';
import { LIMITS } from '../core/constants.js';
import type { ContextObject } from '../core/types.js';
import { ContextRailError } from '../core/errors.js';

export interface WriteRequest {
  /** "object.attribute", e.g. "workspace.activeProject". */
  attributePath: string;
  newValue: unknown;
  sourceEventType: string;
  /** Optional explicit role tags; falls back to the Role Scope Filter default map. */
  roles?: Role[];
}

export interface WriteResult {
  contextObjectId: string;
  attributeName: string;
  version: number;
}

export class ContextObjectRegistry {
  private readonly objects = new Map<string, ContextObject>();

  constructor(private readonly defaultRoles: (attr: string, explicit?: Role[]) => Role[]) {}

  /** Apply a single typed write. Rejects malformed paths without mutating state. */
  write(req: WriteRequest): WriteResult {
    const dot = req.attributePath.indexOf('.');
    if (dot <= 0 || dot === req.attributePath.length - 1) {
      throw new ContextRailError('INTERNAL_ERROR', 'malformed attribute path', {
        attributePath: req.attributePath,
      });
    }
    const objectId = req.attributePath.slice(0, dot);
    const attrName = req.attributePath.slice(dot + 1);

    let obj = this.objects.get(objectId);
    if (!obj) {
      obj = { id: objectId, attributes: {}, version: 0 };
      this.objects.set(objectId, obj);
    }
    const roles = this.defaultRoles(attrName, req.roles);
    obj.attributes[attrName] = { value: req.newValue, roles };
    obj.version += 1;
    return { contextObjectId: objectId, attributeName: attrName, version: obj.version };
  }

  /** Append to the bounded command history (last 50). (SUB-CTX-030) */
  appendHistory(entry: unknown): WriteResult {
    const obj = this.ensure('workspace');
    const current = (obj.attributes['commandHistory']?.value as unknown[]) ?? [];
    const next = [...current, entry].slice(-LIMITS.CTX_HISTORY_MAX);
    obj.attributes['commandHistory'] = { value: next, roles: this.defaultRoles('commandHistory') };
    obj.version += 1;
    return { contextObjectId: 'workspace', attributeName: 'commandHistory', version: obj.version };
  }

  get(objectId: string): ContextObject | undefined {
    return this.objects.get(objectId);
  }

  all(): IterableIterator<ContextObject> {
    return this.objects.values();
  }

  /** Snapshot read for a role with no torn reads (single-threaded). (IFC-CTX-034) */
  list(): ContextObject[] {
    return [...this.objects.values()];
  }

  /** Mark every attribute stale (Degraded mode) or clear staleness (Nominal). (SUB-CTX-034) */
  setStale(stale: boolean): void {
    for (const obj of this.objects.values()) {
      for (const attr of Object.values(obj.attributes)) attr.stale = stale;
    }
  }

  /** Replace the whole snapshot (used on rebuild after restart). (SUB-CTX-080) */
  clear(): void {
    this.objects.clear();
  }

  private ensure(objectId: string): ContextObject {
    let obj = this.objects.get(objectId);
    if (!obj) {
      obj = { id: objectId, attributes: {}, version: 0 };
      this.objects.set(objectId, obj);
    }
    return obj;
  }
}
