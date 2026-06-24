/**
 * ACG + INT verification tests.
 * Maps to SUB-ACG-007/009/010 (default-deny, Maintenance-only, atomic store),
 * SUB-EXE-021 (PERMIT interlock), SUB-INT-013 / SYS-REQ-010 (conflict supersede).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/core/logger.js';
import { AllowlistStore } from '../src/acg/allowlist-store.js';
import { AllowlistAuditLogger } from '../src/acg/allowlist-audit-logger.js';
import { PolicyEngine } from '../src/acg/policy-engine.js';
import { MaintenanceConfigurationInterface } from '../src/acg/maintenance-configuration-interface.js';
import { ConflictSerialiser } from '../src/int/conflict-serialiser.js';

const log = createLogger('test');

function tmpStore(): AllowlistStore {
  const dir = mkdtempSync(join(tmpdir(), 'cr-acg-'));
  return new AllowlistStore(join(dir, 'allowlist.json'), log);
}
function tmpAudit(): AllowlistAuditLogger {
  const dir = mkdtempSync(join(tmpdir(), 'cr-aud-'));
  return new AllowlistAuditLogger(join(dir, 'audit.jsonl'), log);
}

describe('PolicyEngine default-deny gate (SUB-ACG-007)', () => {
  let store: AllowlistStore;
  let engine: PolicyEngine;

  beforeEach(async () => {
    store = tmpStore();
    await store.load(); // seeds defaults (local launch-tool:*, open-url:*, restore-layout)
    engine = new PolicyEngine(store, tmpAudit(), log);
  });

  it('allows a seeded local action and issues a permit', () => {
    const d = engine.evaluate({ principal: 'local', action: 'launch-tool:launch-ide' });
    expect(d.decision).toBe('ALLOW');
    expect(d.permitId).toBeTruthy();
  });

  it('denies an action with no matching allow (default-deny)', () => {
    const d = engine.evaluate({ principal: 'rag', action: 'rm -rf /' });
    expect(d.decision).toBe('DENY');
    expect(d.reason).toBe('COMMAND_NOT_ALLOWED');
    expect(d.permitId).toBeUndefined();
  });

  it('deny entry takes precedence over allow', async () => {
    await store.add({ adapter: 'local', actionPattern: 'launch-tool:danger', effect: 'deny', ruleId: 'block' });
    const d = engine.evaluate({ principal: 'local', action: 'launch-tool:danger' });
    expect(d.decision).toBe('DENY');
  });

  it('permit is single-use and bound to the action (SUB-EXE-021)', () => {
    const d = engine.evaluate({ principal: 'local', action: 'restore-layout' });
    expect(engine.consumePermit(d.permitId, 'restore-layout')).toBe(true);
    // second use fails (already consumed)
    expect(engine.consumePermit(d.permitId, 'restore-layout')).toBe(false);
    // wrong action fails
    const d2 = engine.evaluate({ principal: 'local', action: 'restore-layout' });
    expect(engine.consumePermit(d2.permitId, 'something-else')).toBe(false);
  });
});

describe('MaintenanceConfigurationInterface (SUB-ACG-009)', () => {
  it('rejects mutation outside Maintenance and permits it within', async () => {
    const store = tmpStore();
    await store.load();
    const mci = new MaintenanceConfigurationInterface(store, log);

    mci.setMode('Nominal');
    await expect(mci.add({ adapter: 'local', actionPattern: 'x', effect: 'allow' }, 'op')).rejects.toMatchObject({
      code: 'MODE_RESTRICTION',
    });

    mci.setMode('Maintenance');
    await mci.add({ adapter: 'local', actionPattern: 'x', effect: 'allow' }, 'op');
    expect(mci.list().some((e) => e.actionPattern === 'x')).toBe(true);
  });
});

describe('ConflictSerialiser per-object ordering (SUB-INT-013, SYS-REQ-010)', () => {
  it('runs first, supersedes the older waiter when a newer one arrives', async () => {
    const s = new ConflictSerialiser();
    const a = await s.acquire('obj'); // first -> run
    expect(a).toBe('run');

    const bP = s.acquire('obj'); // waits (a still running)
    const cP = s.acquire('obj'); // supersedes b
    expect(await bP).toBe('superseded');

    s.release('obj'); // promotes c
    expect(await cP).toBe('run');
  });

  it('independent objects do not block each other', async () => {
    const s = new ConflictSerialiser();
    expect(await s.acquire('o1')).toBe('run');
    expect(await s.acquire('o2')).toBe('run');
  });
});
