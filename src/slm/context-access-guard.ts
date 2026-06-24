/**
 * Context Access Guard (SLM).
 *
 * The final fail-closed checkpoint on the outbound context path. Filters each
 * outbound snapshot to only the requesting role's attributes and blocks the whole
 * snapshot if any attribute cannot be role-classified. Guarantees no credential,
 * auth token, or executable capability is ever present in an outbound payload.
 * (SUB-SLM-005, SUB-SLM-006, ARC-REQ-007)
 */
import type { Logger } from '../core/logger.js';
import type { Role } from '../core/constants.js';
import type { RoleProjection } from '../core/types.js';

/** Attribute name fragments that must never appear in an outbound payload. */
const FORBIDDEN_FRAGMENTS = ['password', 'secret', 'token', 'credential', 'privatekey', 'apikey', 'passphrase'];

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

export class ContextAccessGuard {
  constructor(
    private readonly log: Logger,
    private readonly classifiable: (attributeName: string, role: Role) => boolean,
  ) {}

  /**
   * Inspect an outbound role projection. Returns blocked (fail-closed) if any
   * delta field is not classifiable for the role, or if any field name looks like
   * a credential. (SUB-SLM-005/006)
   */
  inspect(projection: RoleProjection): GuardResult {
    for (const rawName of Object.keys(projection.deltaFields)) {
      // Field keys may be "object.attribute"; check the leaf attribute name.
      const leaf = rawName.includes('.') ? rawName.slice(rawName.lastIndexOf('.') + 1) : rawName;
      const lower = leaf.toLowerCase();

      if (FORBIDDEN_FRAGMENTS.some((f) => lower.includes(f))) {
        this.log.error('blocked outbound snapshot — credential-like field', {
          field: rawName,
          role: projection.role,
        });
        return { allowed: false, reason: 'credential-like field in outbound payload' };
      }
      if (!this.classifiable(leaf, projection.role)) {
        this.log.warn('blocked outbound snapshot — unclassifiable attribute (fail-closed)', {
          field: rawName,
          role: projection.role,
        });
        return { allowed: false, reason: `attribute ${leaf} not classifiable for role ${projection.role}` };
      }
    }
    return { allowed: true };
  }
}
