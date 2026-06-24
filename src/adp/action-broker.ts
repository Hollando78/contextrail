/**
 * Action Broker (ADP).
 *
 * Brokers an adapter action: resolves the adapter, confines it to its registered
 * capability scope (denying + logging out-of-scope actions), and runs the BASIC
 * adapter executable through the Process Supervisor (timeout + output capture).
 * The allowlist gate has already been applied upstream by the Policy Engine; this
 * adds the orthogonal capability-scope bound. (SUB-ADP-027, SYS-REQ-014,
 * IFC-ADP-024, IFC-ADP-031)
 */
import type { Logger } from '../core/logger.js';
import type { CommandEnvelope, CommandResult } from '../core/types.js';
import type { CommandExecutor } from '../exe/command-dispatcher.js';
import type { ProcessSupervisor } from '../exe/process-supervisor.js';
import type { OutcomeReporter } from '../exe/outcome-reporter.js';
import type { AdapterRegistry } from './adapter-registry.js';
import { CapabilityScopeEnforcer } from './capability-scope-enforcer.js';

export class ActionBroker implements CommandExecutor {
  private readonly scope = new CapabilityScopeEnforcer();

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly supervisor: ProcessSupervisor,
    private readonly reporter: OutcomeReporter,
    private readonly log: Logger,
  ) {}

  async execute(cmd: CommandEnvelope): Promise<CommandResult> {
    const deny = (reason: CommandResult['reason']): CommandResult => ({
      intentId: cmd.intentId,
      status: 'DENIED',
      exitCode: -1,
      stdoutDigest: '',
      truncated: false,
      elapsedMs: 0,
      ...(reason ? { reason } : {}),
    });

    const adapter = this.registry.get(cmd.adapterId);
    if (!adapter) {
      this.log.warn('adapter not found', { adapterId: cmd.adapterId, intentId: cmd.intentId });
      return deny('ADAPTER_NOT_FOUND');
    }
    if (!this.scope.permits(adapter.capabilityScope, cmd.actionId)) {
      this.log.error('adapter action exceeds capability scope (security violation)', {
        adapterId: cmd.adapterId,
        action: cmd.actionId,
      });
      return deny('CAPABILITY_EXCEEDED');
    }

    // Run the BASIC adapter executable: argv = [actionId, payloadJson].
    const pr = await this.supervisor.run({
      ...cmd,
      targetPath: adapter.execPath ?? process.execPath,
      args: [cmd.actionId, JSON.stringify(cmd.env ?? {})],
      ...(adapter.workingDir ? { env: { ...cmd.env, CR_WORKDIR: adapter.workingDir } } : {}),
    });
    this.reporter.report(pr);
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
