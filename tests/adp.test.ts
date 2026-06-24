/**
 * Adapter Framework verification tests.
 * Maps to SUB-ADP-028 (dir-scope), SYS-REQ-014 / SUB-ADP-027 (capability scope),
 * SUB-EAB-066 (RFC 1918 callback restriction).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/core/logger.js';
import { AdapterRegistry } from '../src/adp/adapter-registry.js';
import { CapabilityScopeEnforcer } from '../src/adp/capability-scope-enforcer.js';
import { isLocalAddress } from '../src/adp/external-application-boundary.js';

const log = createLogger('test');

describe('AdapterRegistry dir-scope (SUB-ADP-028)', () => {
  it('rejects an executable outside the adapter directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cr-adp-'));
    const adapterDir = join(root, 'adapters');
    mkdirSync(adapterDir);
    const reg = new AdapterRegistry(join(root, 'reg.jsonl'), adapterDir, log);

    await expect(
      reg.register({ id: 'evil', type: 'BASIC', execPath: join(root, 'outside.exe'), capabilityScope: ['*'] }),
    ).rejects.toMatchObject({ code: 'UNTRUSTED_ADAPTER' });

    const inside = join(adapterDir, 'ok.exe');
    writeFileSync(inside, '');
    const rec = await reg.register({ id: 'ok', type: 'BASIC', execPath: inside, capabilityScope: ['launch:*'] });
    expect(rec.id).toBe('ok');
    expect(reg.get('ok')).toBeTruthy();
  });

  it('persists and restores registrations (SUB-ADP-072)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cr-adp2-'));
    const adapterDir = join(root, 'adapters');
    mkdirSync(adapterDir);
    const path = join(root, 'reg.jsonl');
    const reg1 = new AdapterRegistry(path, adapterDir, log);
    await reg1.register({ id: 'deep1', type: 'DEEP', capabilityScope: ['context:read'] });

    const reg2 = new AdapterRegistry(path, adapterDir, log);
    await reg2.load();
    expect(reg2.get('deep1')?.type).toBe('DEEP');
  });
});

describe('CapabilityScopeEnforcer (SYS-REQ-014)', () => {
  const scope = new CapabilityScopeEnforcer();
  it('permits in-scope and denies out-of-scope actions', () => {
    expect(scope.permits(['launch-tool:*'], 'launch-tool:ide')).toBe(true);
    expect(scope.permits(['launch-tool:*'], 'ssh:restart')).toBe(false);
    expect(scope.permits(['*'], 'anything')).toBe(true);
  });
});

describe('External Application Boundary RFC 1918 guard (SUB-EAB-066)', () => {
  it('accepts local addresses and rejects public ones', () => {
    expect(isLocalAddress('127.0.0.1')).toBe(true);
    expect(isLocalAddress('192.168.1.5')).toBe(true);
    expect(isLocalAddress('10.0.0.9')).toBe(true);
    expect(isLocalAddress('172.16.4.4')).toBe(true);
    expect(isLocalAddress('8.8.8.8')).toBe(false);
    expect(isLocalAddress('172.32.0.1')).toBe(false);
  });
});
