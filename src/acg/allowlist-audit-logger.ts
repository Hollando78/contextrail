/**
 * Allowlist Audit Logger (ACG).
 *
 * Append-only structured log of every gate decision. On a DENY the entry carries
 * the action identifier, the principal subsystem identity, a UTC millisecond
 * timestamp, and a reason code — written before the DENY is returned.
 * (SUB-ACG-008, SUB-ACG-078 / IEC 62443-3-3 SR 2.1)
 */
import { appendFile } from 'node:fs/promises';
import type { Logger } from '../core/logger.js';
import type { ReasonCode } from '../core/errors.js';

export interface GateDecisionRecord {
  decision: 'ALLOW' | 'DENY';
  action: string;
  principal: string;
  timestamp: string; // ISO 8601, ms precision, UTC
  reason?: ReasonCode;
  ruleId?: string;
  operatorSession?: string;
}

export class AllowlistAuditLogger {
  constructor(
    private readonly path: string,
    private readonly log: Logger,
  ) {}

  /** Append a gate-decision record. Synchronous-enough: returns the write promise. */
  record(rec: GateDecisionRecord): Promise<void> {
    return appendFile(this.path, JSON.stringify(rec) + '\n', 'utf8').catch((err) => {
      // A failed audit write must be visible; never silently drop.
      this.log.error('failed to write allowlist audit record', { err: (err as Error).message, rec });
    });
  }
}
