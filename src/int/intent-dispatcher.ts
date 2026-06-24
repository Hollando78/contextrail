/**
 * Intent Dispatcher (INT).
 *
 * Verifies an ACG PERMIT for each inbound intent before dispatching it to the
 * Workspace Executor / Remote Action Gateway; rejects an intent lacking a valid
 * permit with PERMISSION_DENIED and forwards nothing. Serialises per-object
 * conflicts, confirms dispatch within budget, and opens a circuit breaker after
 * too many consecutive executor failures. (SUB-INT-011, SUB-INT-013, SUB-INT-015)
 */
import type { EventBus } from '../core/bus.js';
import type { Logger } from '../core/logger.js';
import type { Intent, CommandEnvelope, CommandResult, IntentStatus } from '../core/types.js';
import type { PolicyEngine } from '../acg/policy-engine.js';
import type { CommandExecutor } from '../exe/command-dispatcher.js';
import { ConflictSerialiser } from './conflict-serialiser.js';
import { DispatchConfirmer } from './dispatch-confirmer.js';
import { resolveIntent } from './command-resolver.js';

export interface DispatcherServices {
  policy: PolicyEngine;
  executorFor: (adapterId: string) => CommandExecutor | undefined;
}

export class IntentDispatcher {
  private readonly serialiser = new ConflictSerialiser();
  private readonly confirmer: DispatchConfirmer;
  private consecutiveFailures = 0;
  private circuitOpen = false;

  constructor(
    bus: EventBus,
    private readonly deps: DispatcherServices,
    private readonly log: Logger,
    private readonly failureThreshold: number,
  ) {
    this.confirmer = new DispatchConfirmer(bus);
  }

  async handle(intent: Intent): Promise<void> {
    const conf = this.confirmer.begin(intent);

    const resolved = resolveIntent(intent);
    if (!resolved) {
      this.log.warn('unresolvable intent', { type: intent.type, intentId: intent.intentId });
      return conf.settle('FAILURE', { reason: 'INTERNAL_ERROR' });
    }

    if (this.circuitOpen) {
      this.log.warn('circuit open — refusing dispatch', { intentId: intent.intentId });
      return conf.settle('FAILURE', { reason: 'INTERNAL_ERROR', circuit: 'open' });
    }

    // ACG gate — default-deny. (SUB-INT-011)
    const decision = this.deps.policy.evaluate({ principal: resolved.principal, action: resolved.envelope.actionId });
    if (decision.decision === 'DENY') {
      return conf.settle('DENIED', { reason: decision.reason, ruleId: decision.ruleId });
    }

    // Per-object conflict serialisation. (SUB-INT-013)
    const slot = await this.serialiser.acquire(resolved.conflictKey);
    if (slot === 'superseded') {
      return conf.settle('SUPERSEDED', { reason: 'SUPERSEDED' });
    }

    try {
      const executor = this.deps.executorFor(resolved.envelope.adapterId || 'local');
      if (!executor) {
        return conf.settle('FAILURE', { reason: 'INTERNAL_ERROR' });
      }
      const cmd: CommandEnvelope = { ...resolved.envelope, ...(decision.permitId ? { permitId: decision.permitId } : {}) };
      const result: CommandResult = await executor.execute(cmd);
      this.updateCircuit(result.status);
      conf.settle(result.status as IntentStatus, {
        exitCode: result.exitCode,
        elapsedMs: result.elapsedMs,
        ...(result.reason ? { reason: result.reason } : {}),
      });
    } catch (err) {
      this.updateCircuit('FAILURE');
      this.log.error('dispatch error', { intentId: intent.intentId, err: (err as Error).message });
      conf.settle('FAILURE', { reason: 'INTERNAL_ERROR' });
    } finally {
      this.serialiser.release(resolved.conflictKey);
    }
  }

  private updateCircuit(status: string): void {
    if (status === 'FAILURE' || status === 'TIMEOUT') {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold && !this.circuitOpen) {
        this.circuitOpen = true;
        this.log.error('executor circuit opened after consecutive failures', {
          threshold: this.failureThreshold,
        });
      }
    } else {
      this.consecutiveFailures = 0;
      this.circuitOpen = false;
    }
  }
}
