/**
 * Typed, machine-readable error/reason codes surfaced across the system.
 * These appear in deny envelopes, rejection frames, and audit records so the
 * cause of every refusal is operator-transparent. (ARC-REQ-021, and the many
 * SUB/IFC requirements that mandate explicit, machine-readable reasons.)
 */
export const REASON_CODES = [
  'PERMISSION_DENIED', // SUB-INT-011
  'SUPERSEDED', // SUB-INT-013
  'RESOURCE_CONFLICT',
  'CAPABILITY_EXCEEDED', // SUB-DIB-059
  'CAPABILITY_CONFLICT',
  'TOKEN_EXPIRED', // SUB-SLM-002
  'TOKEN_ALREADY_CONSUMED', // SUB-SLM-002
  'TOKEN_UNRECOGNISED', // SUB-SLM-002
  'FINGERPRINT_MISMATCH', // SUB-SLM-001
  'DEVICE_LIMIT_EXCEEDED', // SUB-PAIR-036
  'ROLE_OUT_OF_SET', // SUB-PAIR-037
  'COMMAND_NOT_ALLOWED', // SYS-REQ-004, SUB-RSB-077
  'DENY_NOT_LISTED', // SYS-REQ-004
  'MODE_RESTRICTION', // SUB-ACG-009, SUB-HAS-067
  'RATE_LIMITED', // SUB-RSB-063
  'NON_LOCAL_TARGET', // SUB-EAB-066
  'UNTRUSTED_ADAPTER', // SUB-ADP-081
  'ADAPTER_NOT_FOUND', // IFC-ADP-031
  'UNAUTHORIZED_WRITER', // IFC-EXE-018
  'SNAPSHOT_EXPIRED',
  'TIMEOUT', // SUB-EXE-022, SUB-RAG-048
  'LOCKED', // SUB-RAG-050
  'BOOT_FAILED', // SUB-HCR-019
  'SCHEMA_INVALID', // SUB-HCR-020
  'CONTEXT_OVERFLOW', // SUB-CTX-079
  'INTERNAL_ERROR',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** A refusal that carries a machine-readable reason code and human detail. */
export class ContextRailError extends Error {
  readonly code: ReasonCode;
  readonly detail: Record<string, unknown>;

  constructor(code: ReasonCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ContextRailError';
    this.code = code;
    this.detail = detail;
  }

  toJSON(): { code: ReasonCode; message: string; detail: Record<string, unknown> } {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

export function isContextRailError(e: unknown): e is ContextRailError {
  return e instanceof ContextRailError;
}
