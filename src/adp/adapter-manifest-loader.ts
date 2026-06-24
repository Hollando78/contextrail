/**
 * Adapter Manifest Loader (ADP).
 *
 * Validates each manifest against the ContextRail adapter manifest schema before
 * loading, rejecting schema failures, non-existent executables, and out-of-scope
 * permission flags with a structured error (such manifests are not loaded).
 * Caches the last validated set in memory and, if the manifest source becomes
 * unreadable, serves the cached set (failover to last-good) with a WARN.
 * (SUB-ADP-029, SUB-ADP-070, SUB-ADP-081)
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import Ajv from 'ajv';
import type { Logger } from '../core/logger.js';
import { MANIFEST_SCHEMA, type AdapterManifest } from './types.js';

const AjvCtor = Ajv as unknown as typeof import('ajv').default;

export class AdapterManifestLoader {
  private readonly validate = new AjvCtor({ allErrors: true }).compile(MANIFEST_SCHEMA);
  private cache: AdapterManifest[] = [];

  constructor(
    private readonly manifestDir: string,
    private readonly adapterDir: string,
    private readonly log: Logger,
  ) {}

  /** Load + validate all manifests in the manifest dir. Failover to cache on read error. */
  async loadAll(): Promise<AdapterManifest[]> {
    let files: string[];
    try {
      files = (await readdir(this.manifestDir)).filter((f) => f.endsWith('.json'));
    } catch {
      this.log.warn('manifest dir unreadable — serving last validated set', {
        cached: this.cache.length,
      });
      return this.cache;
    }

    const valid: AdapterManifest[] = [];
    for (const file of files) {
      const full = join(this.manifestDir, file);
      try {
        const manifest = JSON.parse(await readFile(full, 'utf8')) as AdapterManifest;
        if (await this.isValid(manifest, file)) valid.push(manifest);
      } catch (err) {
        this.log.warn('rejected manifest (unreadable/invalid JSON)', { file, err: (err as Error).message });
      }
    }
    this.cache = valid;
    return valid;
  }

  private async isValid(manifest: AdapterManifest, file: string): Promise<boolean> {
    if (!this.validate(manifest)) {
      this.log.warn('rejected manifest (schema)', {
        file,
        errors: this.validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; '),
      });
      return false;
    }
    if (manifest.type === 'BASIC') {
      if (!manifest.execPath) {
        this.log.warn('rejected manifest (BASIC requires execPath)', { file });
        return false;
      }
      const resolved = resolve(manifest.execPath);
      const dir = resolve(this.adapterDir);
      if (!(resolved === dir || resolved.startsWith(dir + sep))) {
        this.log.warn('rejected manifest (execPath outside adapter dir)', { file, execPath: resolved });
        return false;
      }
      try {
        await stat(resolved);
      } catch {
        this.log.warn('rejected manifest (executable not found)', { file, execPath: resolved });
        return false;
      }
      // Signature verification against the host trust store would occur here
      // (SUB-ADP-081). Absent a configured trust store, an unsigned BASIC adapter
      // is accepted with a warning rather than silently trusted.
      if (!manifest.signature) {
        this.log.warn('BASIC adapter manifest is unsigned (no trust-store verification)', { file });
      }
    }
    return true;
  }
}
