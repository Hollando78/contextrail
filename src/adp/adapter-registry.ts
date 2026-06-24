/**
 * Adapter Registry (ADP).
 *
 * Holds registered adapters and their resolved executable path + capability
 * scope. Rejects registration when the declared executable lies outside the
 * host-configured adapter directory, refuses lookups for deregistered adapters,
 * and persists registration state to an append-only log so all adapters are
 * restored on restart without re-registration. (SUB-ADP-028, SUB-ADP-072,
 * IFC-ADP-031)
 */
import { appendFile, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Logger } from '../core/logger.js';
import { ContextRailError } from '../core/errors.js';
import type { RegisteredAdapter } from './types.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, RegisteredAdapter>();

  constructor(
    private readonly path: string,
    private readonly adapterDir: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Restore previously registered adapters. (SUB-ADP-072) */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as RegisteredAdapter & { _deleted?: boolean };
          if (rec._deleted) this.adapters.delete(rec.id);
          else this.adapters.set(rec.id, rec);
        } catch {
          /* skip */
        }
      }
      this.log.info('adapter registry restored', { adapters: this.adapters.size });
    } catch {
      this.log.info('no adapter registry to restore (fresh)');
    }
  }

  /** Register an adapter; rejects an executable outside the adapter dir. */
  async register(manifest: Omit<RegisteredAdapter, 'registeredAt'>): Promise<RegisteredAdapter> {
    if (manifest.type === 'BASIC') {
      if (!manifest.execPath) {
        throw new ContextRailError('UNTRUSTED_ADAPTER', 'BASIC adapter requires an execPath', { id: manifest.id });
      }
      const resolved = resolve(manifest.execPath);
      const dir = resolve(this.adapterDir);
      if (!(resolved === dir || resolved.startsWith(dir + sep))) {
        throw new ContextRailError('UNTRUSTED_ADAPTER', 'executable path outside the adapter directory', {
          id: manifest.id,
          execPath: resolved,
          adapterDir: dir,
        });
      }
    }
    const rec: RegisteredAdapter = { ...manifest, registeredAt: new Date(this.now()).toISOString() };
    this.adapters.set(rec.id, rec);
    await appendFile(this.path, JSON.stringify(rec) + '\n', 'utf8');
    this.log.info('adapter registered', { id: rec.id, type: rec.type });
    return rec;
  }

  async deregister(id: string): Promise<void> {
    if (this.adapters.delete(id)) {
      await appendFile(this.path, JSON.stringify({ id, _deleted: true }) + '\n', 'utf8');
    }
  }

  /** Lookup; returns undefined for unknown/deregistered adapters. (IFC-ADP-031) */
  get(id: string): RegisteredAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): RegisteredAdapter[] {
    return [...this.adapters.values()];
  }
}
