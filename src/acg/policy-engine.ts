/**
 * Policy Engine (ACG).
 *
 * The single default-deny gate every host-mediated external/remote action passes
 * through (ARC-REQ-003/008). Evaluates each request against the Allowlist Store
 * and returns an explicit ALLOW or DENY synchronously, in-process, well within
 * 5 ms (p99). On ALLOW it issues a short-lived single-use PERMIT that the Intent
 * Router attaches to the command and the Workspace Executor verifies before any
 * process runs. (SUB-ACG-007, SUB-INT-011, SUB-EXE-021)
 */
import type { Logger } from '../core/logger.js';
import { generateToken } from '../core/crypto.js';
import type { ReasonCode } from '../core/errors.js';
import type { AllowlistStore } from './allowlist-store.js';
import type { AllowlistAuditLogger } from './allowlist-audit-logger.js';

const PERMIT_TTL_MS = 5_000; // a permit must be consumed promptly by the executor

export interface PermitRequest {
  /** Principal subsystem / adapter identity (e.g. 'local', 'rag', adapter id). */
  principal: string;
  /** Action identifier or command string being gated. */
  action: string;
  operatorSession?: string;
}

export interface PolicyDecision {
  decision: 'ALLOW' | 'DENY';
  reason?: ReasonCode;
  ruleId?: string;
  /** Present only on ALLOW: single-use token the executor consumes. */
  permitId?: string;
}

interface Permit {
  action: string;
  principal: string;
  expiresAt: number;
}

export class PolicyEngine {
  private readonly permits = new Map<string, Permit>();

  constructor(
    private readonly store: AllowlistStore,
    private readonly audit: AllowlistAuditLogger,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Evaluate a request. Default-deny; deny entries take precedence over allow. */
  evaluate(req: PermitRequest): PolicyDecision {
    const { allow, deny } = this.store.matches(req.principal, req.action);
    const ts = new Date(this.now()).toISOString();

    if (deny) {
      void this.audit.record({ decision: 'DENY', action: req.action, principal: req.principal, timestamp: ts, reason: 'DENY_NOT_LISTED', ruleId: deny.ruleId, ...(req.operatorSession ? { operatorSession: req.operatorSession } : {}) });
      return { decision: 'DENY', reason: 'DENY_NOT_LISTED', ...(deny.ruleId ? { ruleId: deny.ruleId } : {}) };
    }
    if (!allow) {
      void this.audit.record({ decision: 'DENY', action: req.action, principal: req.principal, timestamp: ts, reason: 'COMMAND_NOT_ALLOWED', ...(req.operatorSession ? { operatorSession: req.operatorSession } : {}) });
      return { decision: 'DENY', reason: 'COMMAND_NOT_ALLOWED' };
    }

    const permitId = generateToken(128);
    this.permits.set(permitId, { action: req.action, principal: req.principal, expiresAt: this.now() + PERMIT_TTL_MS });
    void this.audit.record({ decision: 'ALLOW', action: req.action, principal: req.principal, timestamp: ts, ...(allow.ruleId ? { ruleId: allow.ruleId } : {}), ...(req.operatorSession ? { operatorSession: req.operatorSession } : {}) });
    return { decision: 'ALLOW', permitId, ...(allow.ruleId ? { ruleId: allow.ruleId } : {}) };
  }

  /** Verify + consume a permit for an action. Single-use. (SUB-EXE-021) */
  consumePermit(permitId: string | undefined, action: string): boolean {
    if (!permitId) return false;
    const p = this.permits.get(permitId);
    if (!p) return false;
    this.permits.delete(permitId);
    if (this.now() > p.expiresAt) return false;
    return p.action === action;
  }

  /** Non-consuming check (used where the same permit covers a multi-step action). */
  hasPermit(permitId: string | undefined): boolean {
    if (!permitId) return false;
    const p = this.permits.get(permitId);
    return !!p && this.now() <= p.expiresAt;
  }

  sweep(): void {
    const now = this.now();
    for (const [id, p] of this.permits) if (now > p.expiresAt) this.permits.delete(id);
  }
}
