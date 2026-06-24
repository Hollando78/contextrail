/**
 * Workspace Context Store verification tests.
 * Maps to SUB-CTX-030/031/079, SYS-REQ-011, IFC-CTX-021/022.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ContextObjectRegistry } from '../src/ctx/context-object-registry.js';
import { RoleScopeFilter } from '../src/ctx/role-scope-filter.js';
import { EventBusAdapter } from '../src/ctx/event-bus-adapter.js';
import { LIMITS } from '../src/core/constants.js';
import { createLogger } from '../src/core/logger.js';

const filter = new RoleScopeFilter();
const mkRegistry = () => new ContextObjectRegistry((a, e) => filter.rolesFor(a, e));

describe('ContextObjectRegistry', () => {
  it('applies writes and bumps version (SUB-CTX-030)', () => {
    const reg = mkRegistry();
    const r = reg.write({ attributePath: 'workspace.activeProject', newValue: 'demo', sourceEventType: 't' });
    expect(r.version).toBe(1);
    expect(reg.get('workspace')?.attributes['activeProject']?.value).toBe('demo');
  });

  it('caps command history at 50 entries (SUB-CTX-030)', () => {
    const reg = mkRegistry();
    for (let i = 0; i < 75; i++) reg.appendHistory({ i });
    const hist = reg.get('workspace')?.attributes['commandHistory']?.value as unknown[];
    expect(hist).toHaveLength(LIMITS.CTX_HISTORY_MAX);
    expect((hist[hist.length - 1] as { i: number }).i).toBe(74);
  });

  it('rejects malformed attribute paths without mutating', () => {
    const reg = mkRegistry();
    expect(() => reg.write({ attributePath: 'nodot', newValue: 1, sourceEventType: 't' })).toThrow();
    expect(reg.list()).toHaveLength(0);
  });
});

describe('RoleScopeFilter (SYS-REQ-011)', () => {
  it('only includes attributes visible to the role', () => {
    const reg = mkRegistry();
    reg.write({ attributePath: 'workspace.commandHistory', newValue: ['x'], sourceEventType: 't' }); // Logs
    reg.write({ attributePath: 'workspace.toolStatus', newValue: { ide: 'ok' }, sourceEventType: 't' }); // Status

    const logsSet = filter.roleAttributeSet(reg.all(), 'Logs');
    expect(Object.keys(logsSet)).toContain('workspace.commandHistory');
    expect(Object.keys(logsSet)).not.toContain('workspace.toolStatus');

    const statusSet = filter.roleAttributeSet(reg.all(), 'Status');
    expect(Object.keys(statusSet)).toContain('workspace.toolStatus');
    expect(Object.keys(statusSet)).not.toContain('workspace.commandHistory');
  });

  it('produces a deterministic SHA-256 digest for a role projection (IFC-CTX-022)', () => {
    const reg = mkRegistry();
    reg.write({ attributePath: 'workspace.toolStatus', newValue: { ide: 'ok' }, sourceEventType: 't' });
    const obj = reg.get('workspace')!;
    const p1 = filter.project('d1', 'Status', obj, ['toolStatus'], reg.all(), false);
    const p2 = filter.project('d1', 'Status', obj, ['toolStatus'], reg.all(), false);
    expect(p1?.digest).toEqual(p2?.digest);
    expect(p1?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null when no delta field is visible to the role', () => {
    const reg = mkRegistry();
    reg.write({ attributePath: 'workspace.commandHistory', newValue: ['x'], sourceEventType: 't' });
    const obj = reg.get('workspace')!;
    expect(filter.project('d1', 'Status', obj, ['commandHistory'], reg.all(), false)).toBeNull();
  });
});

describe('EventBusAdapter bounded queue (SUB-CTX-079)', () => {
  let updates: number;
  let overflowDropped: number;

  beforeEach(() => {
    updates = 0;
    overflowDropped = 0;
  });

  it('drops oldest and emits overflow beyond 200 pending', async () => {
    const reg = mkRegistry();
    const log = createLogger('test');
    const adapter = new EventBusAdapter(
      reg,
      log,
      () => {
        updates++;
      },
      (dropped) => {
        overflowDropped = dropped;
      },
    );

    // Synchronously enqueue more than capacity before the microtask drain runs.
    for (let i = 0; i < LIMITS.CTX_QUEUE_MAX + 25; i++) {
      adapter.ingest({
        type: 'raw',
        writes: [{ attributePath: `o${i}.a`, newValue: i, sourceEventType: 't' }],
      });
    }
    expect(adapter.overflows).toBeGreaterThanOrEqual(25);
    expect(overflowDropped).toBeGreaterThan(0);

    // Drain the queue.
    await new Promise((r) => setTimeout(r, 10));
    expect(updates).toBeGreaterThan(0);
    expect(adapter.pending).toBe(0);
  });
});
