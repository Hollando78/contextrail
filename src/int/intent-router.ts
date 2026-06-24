/**
 * Intent Router (INT) subsystem.
 *
 * Receives high-level intents from desklets (via the transport's
 * 'intent:received' bus event), routes each to the correct host execution path,
 * and reports explicit outcomes back to the originating role. Composes the Intent
 * Dispatcher, Conflict Serialiser, and Dispatch Confirmer. (FN-FN-010/011/013)
 */
import { BaseSubsystem, type RuntimeContext, type SubsystemHealth } from '../core/subsystem.js';
import { SERVICE } from '../core/services.js';
import type { PolicyEngine } from '../acg/policy-engine.js';
import type { CommandExecutor } from '../exe/command-dispatcher.js';
import type { ActionsRegistry } from '../actions/actions-registry.js';
import { IntentDispatcher } from './intent-dispatcher.js';

export class IntentRouter extends BaseSubsystem {
  readonly name = 'IntentRouter';

  private dispatcher!: IntentDispatcher;
  private off: (() => void) | undefined;

  constructor(ctx: RuntimeContext) {
    super(ctx);
    this.init();
  }

  override async start(): Promise<void> {
    const policy = this.services.get<PolicyEngine>(SERVICE.PolicyEngine);
    this.dispatcher = new IntentDispatcher(
      this.bus,
      {
        policy,
        actions: this.services.tryGet<ActionsRegistry>(SERVICE.Actions),
        executorFor: (adapterId) => {
          if (adapterId === 'rag') return this.services.tryGet<CommandExecutor>(SERVICE.RemoteGateway);
          if (adapterId && adapterId !== 'local') return this.services.tryGet<CommandExecutor>(SERVICE.AdapterFramework);
          return this.services.tryGet<CommandExecutor>(SERVICE.Executor);
        },
      },
      this.log.child('dispatch'),
      this.config.failureCircuitThreshold,
    );

    this.off = this.bus.on('intent:received', (intent) => void this.dispatcher.handle(intent));
    this.services.set(SERVICE.IntentRouter, this);
    this.log.info('intent router ready');
  }

  override async stop(): Promise<void> {
    this.off?.();
  }

  override health(): SubsystemHealth {
    return { status: 'nominal' };
  }
}
