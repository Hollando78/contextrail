/**
 * Security & Lock Manager verification tests.
 * Maps to SUB-SLM-001/002 (single-use, fingerprint-bound, 60s expiry),
 * SUB-SLM-004 / ARC-REQ-006 (lock state machine), SUB-SLM-006 (fail-closed guard).
 */
import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/core/bus.js';
import { createLogger } from '../src/core/logger.js';
import { PairingTokenAuthority } from '../src/slm/pairing-token-authority.js';
import { LockStateController } from '../src/slm/lock-state-controller.js';
import { ContextAccessGuard } from '../src/slm/context-access-guard.js';
import { TOKENS } from '../src/core/constants.js';
import type { RoleProjection } from '../src/core/types.js';

const log = createLogger('test');

describe('PairingTokenAuthority (SUB-SLM-001/002)', () => {
  it('validates a single-use token bound to a fingerprint', () => {
    const pta = new PairingTokenAuthority(log);
    const { token } = pta.issueSessionToken('fp-1', 'Status');
    const ok = pta.validate(token, 'fp-1');
    expect(ok.valid).toBe(true);
    expect(ok.role).toBe('Status');
    // single-use: second validate is rejected
    expect(pta.validate(token, 'fp-1').reason).toBe('TOKEN_ALREADY_CONSUMED');
  });

  it('rejects a fingerprint mismatch', () => {
    const pta = new PairingTokenAuthority(log);
    const { token } = pta.issueSessionToken('fp-1', 'Logs');
    expect(pta.validate(token, 'fp-other').reason).toBe('FINGERPRINT_MISMATCH');
  });

  it('expires an unredeemed token after 60s (SYS-REQ-002)', () => {
    let t = 1_000_000;
    const pta = new PairingTokenAuthority(log, () => t);
    const { token } = pta.issueSessionToken('fp-1', 'AI');
    t += TOKENS.PAIRING_TTL_MS + 1;
    expect(pta.validate(token, 'fp-1').reason).toBe('TOKEN_EXPIRED');
  });

  it('rejects an unrecognised token', () => {
    const pta = new PairingTokenAuthority(log);
    expect(pta.validate('a.b.c', 'fp').reason).toBe('TOKEN_UNRECOGNISED');
  });
});

describe('LockStateController (SUB-SLM-004, ARC-REQ-006)', () => {
  it('emits lock events and tracks state', () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.on('lock:engaged', () => events.push('engaged'));
    bus.on('lock:released', () => events.push('released'));
    const lsc = new LockStateController(bus, log);

    expect(lsc.isLocked()).toBe(false);
    lsc.engage('test');
    expect(lsc.isLocked()).toBe(true);
    lsc.engage('again'); // idempotent
    lsc.release();
    expect(lsc.isLocked()).toBe(false);
    expect(events).toEqual(['engaged', 'released']);
  });
});

describe('ContextAccessGuard fail-closed (SUB-SLM-006)', () => {
  const guard = new ContextAccessGuard(log, (attr, role) =>
    (attr === 'toolStatus' && role === 'Status'),
  );

  it('blocks a snapshot containing a credential-like field', () => {
    const p: RoleProjection = {
      deskletId: 'd', role: 'Status', contextObjectId: 'workspace',
      deltaFields: { 'workspace.password': 'secret' }, version: 1, digest: 'x', stale: false,
    };
    expect(guard.inspect(p).allowed).toBe(false);
  });

  it('blocks an unclassifiable attribute (fail-closed)', () => {
    const p: RoleProjection = {
      deskletId: 'd', role: 'Status', contextObjectId: 'workspace',
      deltaFields: { 'workspace.mystery': 1 }, version: 1, digest: 'x', stale: false,
    };
    expect(guard.inspect(p).allowed).toBe(false);
  });

  it('allows a classifiable, role-scoped attribute', () => {
    const p: RoleProjection = {
      deskletId: 'd', role: 'Status', contextObjectId: 'workspace',
      deltaFields: { toolStatus: { ide: 'ok' } }, version: 1, digest: 'x', stale: false,
    };
    expect(guard.inspect(p).allowed).toBe(true);
  });
});
