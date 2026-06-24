/**
 * Command Dispatcher (EXE).
 *
 * Verifies a current PERMIT on each CommandEnvelope (rejecting with DENIED within
 * 5 ms and no process invocation when absent), routes by adapter id, and runs
 * commands strictly sequentially — never two subprocesses at once, queueing while
 * busy. (SUB-EXE-021, SUB-EXE-025, SUB-EXE-026)
 *
 * Routing (SUB-EXE-026): '' / 'local' -> Process Supervisor; 'rag' -> Remote
 * Action Gateway; any other id -> Adapter Framework broker.
 */
import type { Logger } from '../core/logger.js';
import type { CommandEnvelope, CommandResult } from '../core/types.js';
import type { PolicyEngine } from '../acg/policy-engine.js';
import type { ProcessSupervisor, ProcessResult } from './process-supervisor.js';
import type { OutcomeReporter } from './outcome-reporter.js';

/** Anything that can execute a non-local command (RAG / Adapter Framework). */
export interface CommandExecutor {
  execute(cmd: CommandEnvelope): Promise<CommandResult>;
}

export interface DispatcherDeps {
  policy: PolicyEngine;
  supervisor: ProcessSupervisor;
  reporter: OutcomeReporter;
  remoteGateway: () => CommandExecutor | undefined;
  adapterFramework: () => CommandExecutor | undefined;
}

export class CommandDispatcher {
  /** Tail of the sequential execution chain. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: DispatcherDeps,
    private readonly log: Logger,
  ) {}

  /** Enqueue a command; resolves with its result once it has run in order. */
  dispatch(cmd: CommandEnvelope): Promise<CommandResult> {
    const run = this.chain.then(() => this.runOne(cmd));
    // Keep the chain alive regardless of individual failures.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async runOne(cmd: CommandEnvelope): Promise<CommandResult> {
    // PERMIT interlock — no permit, no process. (SUB-EXE-021)
    if (!this.deps.policy.consumePermit(cmd.permitId, cmd.actionId)) {
      this.log.warn('command rejected — no valid PERMIT', { intentId: cmd.intentId, actionId: cmd.actionId });
      const denied: CommandResult = {
        intentId: cmd.intentId,
        status: 'DENIED',
        exitCode: -1,
        stdoutDigest: '',
        truncated: false,
        elapsedMs: 0,
        reason: 'PERMISSION_DENIED',
      };
      return denied;
    }

    const adapter = cmd.adapterId || 'local';
    if (adapter === 'local') {
      const pr = await this.deps.supervisor.run(cmd);
      this.deps.reporter.report(pr);
      return this.toResult(pr);
    }

    const target = adapter === 'rag' ? this.deps.remoteGateway() : this.deps.adapterFramework();
    if (!target) {
      this.log.warn('no executor for adapter', { adapter, intentId: cmd.intentId });
      return {
        intentId: cmd.intentId,
        status: 'FAILURE',
        exitCode: -1,
        stdoutDigest: '',
        truncated: false,
        elapsedMs: 0,
        reason: 'INTERNAL_ERROR',
      };
    }
    return target.execute(cmd);
  }

  private toResult(pr: ProcessResult): CommandResult {
    return {
      intentId: pr.intentId,
      status: pr.status,
      exitCode: pr.exitCode,
      stdoutDigest: pr.stdoutDigest,
      truncated: pr.truncated,
      elapsedMs: pr.elapsedMs,
      ...(pr.status === 'TIMEOUT' ? { reason: 'TIMEOUT' as const } : {}),
    };
  }
}
