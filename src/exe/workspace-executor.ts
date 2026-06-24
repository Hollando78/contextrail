/**
 * Workspace Executor (EXE) subsystem.
 *
 * Executes dispatched commands locally and reports explicit outcomes. Composes
 * the Command Dispatcher, Process Supervisor, and Outcome Reporter. Exposes an
 * `execute(CommandEnvelope)` service the Intent Router (and RAG, for 'rag'
 * commands) call. (FN-FN-012, ARC-REQ-011)
 */
import { BaseSubsystem, type RuntimeContext, type SubsystemHealth } from '../core/subsystem.js';
import { SERVICE } from '../core/services.js';
import type { CommandEnvelope, CommandResult } from '../core/types.js';
import type { PolicyEngine } from '../acg/policy-engine.js';
import { ProcessSupervisor } from './process-supervisor.js';
import { OutcomeReporter } from './outcome-reporter.js';
import { CommandDispatcher, type CommandExecutor } from './command-dispatcher.js';

export class WorkspaceExecutor extends BaseSubsystem implements CommandExecutor {
  readonly name = 'WorkspaceExecutor';

  private supervisor!: ProcessSupervisor;
  private reporter!: OutcomeReporter;
  private dispatcher!: CommandDispatcher;

  constructor(ctx: RuntimeContext) {
    super(ctx);
    this.init();
  }

  override async start(): Promise<void> {
    const policy = this.services.get<PolicyEngine>(SERVICE.PolicyEngine);
    this.supervisor = new ProcessSupervisor(this.log.child('proc'), (intentId) =>
      this.log.debug('execution started', { intentId }),
    );
    this.reporter = new OutcomeReporter(this.bus);
    this.dispatcher = new CommandDispatcher(
      {
        policy,
        supervisor: this.supervisor,
        reporter: this.reporter,
        remoteGateway: () => this.services.tryGet<CommandExecutor>(SERVICE.RemoteGateway),
        adapterFramework: () => this.services.tryGet<CommandExecutor>(SERVICE.AdapterFramework),
      },
      this.log.child('dispatch'),
    );
    this.services.set(SERVICE.Executor, this);
    this.log.info('workspace executor ready');
  }

  override async stop(): Promise<void> {
    /* in-flight commands resolve naturally; nothing persistent to release */
  }

  override health(): SubsystemHealth {
    return { status: 'nominal' };
  }

  execute(cmd: CommandEnvelope): Promise<CommandResult> {
    return this.dispatcher.dispatch(cmd);
  }
}
