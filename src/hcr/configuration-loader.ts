/**
 * Configuration Loader (HCR) — boot step 1.
 *
 * Validates the loaded config against the embedded JSON Schema and signals READY
 * only after validation succeeds; otherwise boot halts with a structured error
 * identifying the failing schema path. The validated config is provided as a
 * read-only structure before any other subsystem starts. (SUB-HCR-020,
 * IFC-HCR-016)
 */
import { BaseSubsystem, type RuntimeContext, type SubsystemHealth } from '../core/subsystem.js';
import { validateConfig } from '../core/config.js';
import { ensureDir, resolveDataDir } from '../core/paths.js';

export class ConfigurationLoader extends BaseSubsystem {
  readonly name = 'ConfigurationLoader';

  constructor(ctx: RuntimeContext) {
    super(ctx);
    this.init();
  }

  override async start(): Promise<void> {
    // Re-validate (defensive) and ensure the data directory exists.
    validateConfig(this.config);
    const dir = await ensureDir(resolveDataDir(this.config.dataDir));
    this.log.info('configuration validated', { dataDir: dir, port: this.config.port });
  }

  override async stop(): Promise<void> {
    /* nothing to release */
  }

  override health(): SubsystemHealth {
    return { status: 'nominal' };
  }
}
