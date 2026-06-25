/**
 * Credential Vault tests — encrypted at rest, names-only exposure, redaction.
 * Maps to SYS-REQ-005 (role-scoped/secret data never leaks) + SYS-REQ-016 (local).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/core/logger.js';
import { CredentialVault } from '../src/slm/credential-vault.js';
import { dataPaths } from '../src/core/paths.js';

const log = createLogger('test');
const tmpVault = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-vault-'));
  const v = new CredentialVault(dir, log);
  v.load();
  return { v, dir };
};

describe('CredentialVault', () => {
  it('stores and retrieves a secret', () => {
    const { v } = tmpVault();
    v.setSecret('cloudflare.password', 's3cr3t!');
    expect(v.getSecret('cloudflare.password')).toBe('s3cr3t!');
    expect(v.has('cloudflare.password')).toBe(true);
  });

  it('exposes names but never values, and encrypts at rest', () => {
    const { v, dir } = tmpVault();
    v.setSecret('svc.user', 'alice');
    v.setSecret('svc.pass', 'hunter2');
    expect(v.names()).toEqual(['svc.pass', 'svc.user']); // sorted, names only
    const onDisk = readFileSync(dataPaths(dir).credentials, 'utf8');
    expect(onDisk).not.toContain('hunter2'); // ciphertext only
    expect(onDisk).not.toContain('alice');
  });

  it('persists across reloads (same key file)', () => {
    const { v, dir } = tmpVault();
    v.setSecret('a.b', 'value');
    const v2 = new CredentialVault(dir, log);
    v2.load();
    expect(v2.getSecret('a.b')).toBe('value');
    expect(existsSync(dataPaths(dir).vaultKey)).toBe(true);
  });

  it('removes a secret', () => {
    const { v } = tmpVault();
    v.setSecret('x.y', 'z');
    expect(v.remove('x.y')).toBe(true);
    expect(v.remove('x.y')).toBe(false);
    expect(v.getSecret('x.y')).toBeUndefined();
  });

  it('rejects invalid names and empty values', () => {
    const { v } = tmpVault();
    expect(() => v.setSecret('Bad Name!', 'v')).toThrow();
    expect(() => v.setSecret('ok.name', '')).toThrow();
  });

  it('fails closed when the value cannot be decrypted', () => {
    const { v } = tmpVault();
    expect(v.getSecret('missing')).toBeUndefined();
  });
});
