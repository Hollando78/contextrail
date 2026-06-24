/**
 * Adapter Framework (ADP) subsystem.
 *
 * Registers and validates BASIC/DEEP adapters bounded by the host capability
 * model, and brokers adapter actions. Composes the Adapter Registry, Adapter
 * Manifest Loader, Action Broker, External Application Boundary, and Deep
 * Integration Boundary. Exposes a CommandExecutor for the executor's
 * non-local/non-rag adapter route. (FN-FN-014/015, SYS-REQ-014)
 */
import { BaseSubsystem, type RuntimeContext, type SubsystemHealth } from '../core/subsystem.js';
import { SERVICE } from '../core/services.js';
import { dataPaths } from '../core/paths.js';
import type { CommandEnvelope, CommandResult } from '../core/types.js';
import type { CommandExecutor } from '../exe/command-dispatcher.js';
import type { PolicyEngine } from '../acg/policy-engine.js';
import { ProcessSupervisor } from '../exe/process-supervisor.js';
import { OutcomeReporter } from '../exe/outcome-reporter.js';
import { AdapterRegistry } from './adapter-registry.js';
import { AdapterManifestLoader } from './adapter-manifest-loader.js';
import { ActionBroker } from './action-broker.js';
import { ExternalApplicationBoundary } from './external-application-boundary.js';
import { DeepIntegrationBoundary } from './deep-integration-boundary.js';

export class AdapterFramework extends BaseSubsystem implements CommandExecutor {
  readonly name = 'AdapterFramework';

  private registry!: AdapterRegistry;
  private loader!: AdapterManifestLoader;
  private broker!: ActionBroker;
  readonly eab: ExternalApplicationBoundary;
  private dib: DeepIntegrationBoundary | undefined;

  constructor(ctx: RuntimeContext) {
    super(ctx);
    this.init();
    this.eab = new ExternalApplicationBoundary(this.log.child('eab'));
  }

  override async start(): Promise<void> {
    const paths = dataPaths(this.config.dataDir);
    const policy = this.services.get<PolicyEngine>(SERVICE.PolicyEngine);

    this.registry = new AdapterRegistry(paths.adapterRegistry, this.config.adapterDir, this.log.child('registry'));
    await this.registry.load();

    this.loader = new AdapterManifestLoader(this.config.manifestDir, this.config.adapterDir, this.log.child('manifest'));
    const manifests = await this.loader.loadAll();
    for (const m of manifests) {
      try {
        await this.registry.register(m);
      } catch (err) {
        this.log.warn('manifest valid but registration refused', { id: m.id, err: (err as Error).message });
      }
    }

    const supervisor = new ProcessSupervisor(this.log.child('proc'));
    const reporter = new OutcomeReporter(this.bus);
    this.broker = new ActionBroker(this.registry, supervisor, reporter, this.log.child('broker'));

    // Deep Integration Boundary (best-effort: a socket bind failure must not abort boot).
    try {
      this.dib = new DeepIntegrationBoundary(paths.deepSocket, this.bus, policy, this.log.child('dib'));
      await this.dib.start();
    } catch (err) {
      this.log.warn('deep integration boundary unavailable', { err: (err as Error).message });
      this.dib = undefined;
    }

    this.services.set(SERVICE.AdapterFramework, this);
    this.log.info('adapter framework ready', { adapters: this.registry.list().length });
  }

  override async stop(): Promise<void> {
    await this.dib?.stop();
  }

  override health(): SubsystemHealth {
    return {
      status: 'nominal',
      detail: { adapters: this.registry?.list().length ?? 0, deepSessions: this.dib?.sessionCount() ?? 0 },
    };
  }

  /** Executor route for adapter-brokered (non-local, non-rag) commands. */
  execute(cmd: CommandEnvelope): Promise<CommandResult> {
    return this.broker.execute(cmd);
  }
}
