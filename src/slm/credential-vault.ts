/**
 * Credential Vault (SLM).
 *
 * Encrypts named secrets at rest (AES-256-GCM) so actions can reference a secret
 * by name — e.g. a `login` action's `cloudflare.password` — without the plaintext
 * ever appearing in an action definition, a log line, or a desklet projection.
 * Secrets are resolved only at the moment of execution, by the Process Supervisor.
 *
 * Local-first and operator-only: the vault file and its key live under the data
 * directory with 0600 permissions; values are written/read exclusively over the
 * loopback admin API by the host operator and are never returned to a desklet.
 * (SYS-REQ-001, SYS-REQ-005, SYS-REQ-016, ARC-REQ-001/020)
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dataPaths } from '../core/paths.js';
import type { Logger } from '../core/logger.js';

interface SealedSecret {
  iv: string;
  tag: string;
  ct: string;
}

export class CredentialVault {
  private key: Buffer = Buffer.alloc(0);
  private store: Record<string, SealedSecret> = {};

  constructor(
    private readonly dataDir: string,
    private readonly log: Logger,
  ) {}

  /** Load (or generate) the master key and decrypt-on-demand store from disk. */
  load(): void {
    const p = dataPaths(this.dataDir);
    if (existsSync(p.vaultKey)) {
      this.key = Buffer.from(readFileSync(p.vaultKey, 'utf8').trim(), 'hex');
    } else {
      this.key = randomBytes(32);
      writeFileSync(p.vaultKey, this.key.toString('hex'), { mode: 0o600 });
      this.harden(p.vaultKey);
      this.log.info('generated new vault key');
    }
    if (this.key.length !== 32) throw new Error('vault key must be 32 bytes');

    if (existsSync(p.credentials)) {
      try {
        this.store = JSON.parse(readFileSync(p.credentials, 'utf8'));
      } catch {
        this.store = {};
      }
    }
    this.log.info('credential vault loaded', { secrets: Object.keys(this.store).length });
  }

  /** Store (or replace) a secret. Value is encrypted immediately; never logged. */
  setSecret(name: string, value: string): void {
    const n = this.normalise(name);
    if (typeof value !== 'string' || !value.length) throw new Error('secret value is required');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.store[n] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
    this.persist();
    this.log.info('secret stored', { name: n }); // name only — never the value
  }

  /** Decrypt a secret for execution. Returns undefined if absent or tampered. */
  getSecret(name: string): string | undefined {
    const e = this.store[this.normalise(name)];
    if (!e) return undefined;
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(e.iv, 'base64'));
      d.setAuthTag(Buffer.from(e.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()]).toString('utf8');
    } catch {
      this.log.warn('secret decrypt failed (key mismatch or tamper)', { name: this.normalise(name) });
      return undefined;
    }
  }

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.store, this.normalise(name));
  }

  /** The names of stored secrets (never the values) — safe for the operator UI. */
  names(): string[] {
    return Object.keys(this.store).sort();
  }

  remove(name: string): boolean {
    const n = this.normalise(name);
    if (!this.store[n]) return false;
    delete this.store[n];
    this.persist();
    return true;
  }

  /** Secret names are namespaced, lowercase identifiers: `service.field`. */
  private normalise(name: string): string {
    const n = String(name).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(n)) throw new Error('invalid secret name (use letters, digits, . _ -)');
    return n;
  }

  private persist(): void {
    const p = dataPaths(this.dataDir);
    writeFileSync(p.credentials, JSON.stringify(this.store), { mode: 0o600 });
    this.harden(p.credentials);
  }

  private harden(path: string): void {
    try {
      chmodSync(path, 0o600); // best-effort on Windows
    } catch {
      /* non-POSIX filesystems ignore this */
    }
  }
}
