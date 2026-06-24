/**
 * Actions Registry tests — customisable, config-driven action set.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/core/logger.js';
import { ActionsRegistry } from '../src/actions/actions-registry.js';
import { resolveIntent } from '../src/int/command-resolver.js';
import type { Intent } from '../src/core/types.js';

const log = createLogger('test');

function registryWith(actions: unknown): ActionsRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'cr-act-'));
  const committed = join(dir, 'actions.json');
  writeFileSync(committed, JSON.stringify(actions));
  const r = new ActionsRegistry(committed, join(dir, 'actions.local.json'), log);
  r.load();
  return r;
}

const intent = (type: string, payload: Record<string, unknown>): Intent => ({
  intentId: 'i1', correlationId: 'c1', deskletId: 'd1', role: 'Actions', type, payload, receiptTimestamp: 't',
});

describe('ActionsRegistry', () => {
  it('loads, filters invalid entries, and looks up by id', () => {
    const r = registryWith([
      { id: 'a', label: 'A', kind: 'url', target: 'https://x' },
      { id: 'b', label: 'B', kind: 'app', target: 'notepad' },
      { label: 'missing id', kind: 'url' }, // dropped
    ]);
    expect(r.list()).toHaveLength(2);
    expect(r.get('a')?.target).toBe('https://x');
    expect(r.get('nope')).toBeUndefined();
  });

  it('views are desklet-safe (no targets/commands leak)', () => {
    const r = registryWith([{ id: 'a', label: 'A', icon: '🌐', kind: 'url', target: 'https://secret' }]);
    const v = r.views()[0]!;
    expect(v).toEqual({ id: 'a', label: 'A', icon: '🌐', kind: 'url' });
    expect(JSON.stringify(r.views())).not.toContain('secret');
  });
});

describe('resolveIntent with action registry', () => {
  const r = registryWith([
    { id: 'open-x', label: 'Open X', kind: 'url', target: 'https://x' },
    { id: 'deploy', label: 'Deploy', kind: 'ssh', command: 'deploy app', host: 'prod', commandClass: 'streaming' },
  ]);

  it('routes a url action to local with gated id action:<id>', () => {
    const res = resolveIntent(intent('action', { actionId: 'open-x' }), r);
    expect(res?.principal).toBe('local');
    expect(res?.envelope.actionId).toBe('action:open-x');
    expect(res?.envelope.detached).toBe(true);
  });

  it('routes an ssh action to the rag adapter, gated by the command text', () => {
    const res = resolveIntent(intent('action', { actionId: 'deploy' }), r);
    expect(res?.principal).toBe('rag');
    expect(res?.envelope.adapterId).toBe('rag');
    expect(res?.envelope.actionId).toBe('deploy app');
    expect(res?.envelope.env['TARGET_HOST']).toBe('prod');
  });

  it('returns null for an unknown action id', () => {
    expect(resolveIntent(intent('action', { actionId: 'ghost' }), r)).toBeNull();
  });
});
