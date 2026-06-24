/**
 * ContextRail host entrypoint.
 *
 * Loads + validates config, builds the runtime context, wires the subsystems in
 * boot order, and hands them to the Host Core Runtime to boot to Nominal.
 * Subsystems not yet implemented are booted as explicit stubs and swapped for
 * their real implementations as the build progresses.
 */
import { EventBus } from '../core/bus.js';
import { loadConfig } from '../core/config.js';
import { createLogger, rootLogger } from '../core/logger.js';
import { resolveDataDir, ensureDir } from '../core/paths.js';
import type { RuntimeContext, Subsystem } from '../core/subsystem.js';
import { StubSubsystem } from '../core/stub-subsystem.js';
import { ServiceRegistry } from '../core/services.js';
import { ConfigurationLoader } from '../hcr/configuration-loader.js';
import { HostCoreRuntime } from '../hcr/host-core-runtime.js';
import { WorkspaceContextStore } from '../ctx/workspace-context-store.js';
import { SecurityAndLockManager } from '../slm/security-and-lock-manager.js';
import { DeskletPairingAndIdentity } from '../pair/desklet-pairing-and-identity.js';
import { AllowlistAndConfigurationGovernance } from '../acg/allowlist-and-configuration-governance.js';
import { WorkspaceExecutor } from '../exe/workspace-executor.js';
import { AdapterFramework } from '../adp/adapter-framework.js';
import { RemoteActionGateway } from '../rag/remote-action-gateway.js';
import { IntentRouter } from '../int/intent-router.js';
import { HostAdministrationStation } from '../has/host-administration-station.js';
import { LocalTransportServer } from '../xpt/local-transport-server.js';
import { SERVICE } from '../core/services.js';
import { isContextRailError } from '../core/errors.js';

async function main(): Promise<void> {
  const configPath = process.env['CONTEXTRAIL_CONFIG'] ?? process.argv[2];
  const log = rootLogger;

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    if (isContextRailError(err)) {
      log.error('configuration invalid', err.toJSON());
    } else {
      log.error('configuration load failed', { err: (err as Error).message });
    }
    process.exitCode = 1;
    return;
  }

  const dataDir = await ensureDir(resolveDataDir(config.dataDir));
  const bus = new EventBus();
  const ctx: RuntimeContext = {
    bus,
    config,
    logger: createLogger('sub'),
    dataDir,
    services: new ServiceRegistry(),
  };

  const hcr = new HostCoreRuntime(bus, log);
  // Expose a mode-control surface so the Host Admin Station can drive Maintenance.
  ctx.services.set(SERVICE.ModeControl, {
    mode: () => hcr.mode(),
    enterMaintenance: () => hcr.enterMaintenance(),
    leaveMaintenance: () => hcr.leaveMaintenance(),
  });

  // Boot order per SUB-HCR-019. Real subsystems replace these stubs as built.
  const ordered: Subsystem[] = [
    new ConfigurationLoader(ctx),
    new WorkspaceContextStore(ctx),
    new SecurityAndLockManager(ctx),
    new DeskletPairingAndIdentity(ctx),
    new AllowlistAndConfigurationGovernance(ctx),
    new WorkspaceExecutor(ctx),
    new LocalTransportServer(ctx),
    new AdapterFramework(ctx),
    new RemoteActionGateway(ctx),
    new IntentRouter(ctx),
    new HostAdministrationStation(ctx),
  ];

  try {
    await hcr.boot(ordered);
  } catch (err) {
    log.error('host failed to boot', isContextRailError(err) ? err.toJSON() : { err: String(err) });
    process.exitCode = 1;
    return;
  }

  const shutdown = async (signal: string) => {
    log.info('shutdown signal received', { signal });
    await hcr.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  log.info('ContextRail host is running', {
    mode: hcr.mode(),
    url: `https://${config.host}:${config.port}`,
  });
}

void main();
