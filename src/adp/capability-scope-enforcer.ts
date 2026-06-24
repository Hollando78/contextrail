/**
 * Capability Scope Enforcer (shared by Adapter Framework + Deep Integration
 * Boundary). Confines each adapter to its registered capability set; denies and
 * is the single place capability bounds are checked. (SUB-ADP-027, SUB-DIB-059,
 * SYS-REQ-014)
 */
export class CapabilityScopeEnforcer {
  /** True if `action` is within one of the adapter's capability patterns. */
  permits(capabilityScope: readonly string[], action: string): boolean {
    return capabilityScope.some((pattern) => matchPattern(pattern, action));
  }
}

function matchPattern(pattern: string, action: string): boolean {
  if (pattern === '*' || pattern === action) return true;
  if (!pattern.includes('*')) return false;
  const rx = new RegExp('^' + pattern.split('*').map(esc).join('.*') + '$');
  return rx.test(action);
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
