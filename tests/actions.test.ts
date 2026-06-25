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

describe('ActionsRegistry editing + persistence', () => {
  it('upserts a new action, deriving a unique id from the label', async () => {
    const r = registryWith([{ id: 'a', label: 'A', kind: 'url', target: 'https://x' }]);
    const def = await r.upsert({ label: 'Open Docs', kind: 'url', target: 'https://docs' });
    expect(def.id).toBe('open-docs');
    expect(r.get('open-docs')?.target).toBe('https://docs');
    // a second action with the same label gets a distinct id
    const def2 = await r.upsert({ label: 'Open Docs', kind: 'url', target: 'https://docs2' });
    expect(def2.id).toBe('open-docs-2');
  });

  it('updates an existing action in place and persists to actions.local.json', async () => {
    const r = registryWith([{ id: 'a', label: 'A', kind: 'app', target: 'notepad' }]);
    await r.upsert({ id: 'a', label: 'A renamed', kind: 'app', target: 'code' });
    expect(r.list()).toHaveLength(1);
    expect(r.get('a')?.label).toBe('A renamed');
    expect(r.get('a')?.target).toBe('code');
  });

  it('rejects an action missing its required target', async () => {
    const r = registryWith([]);
    await expect(r.upsert({ label: 'Bad', kind: 'url' })).rejects.toThrow(/target/);
  });

  it('accepts a login action with two secret refs and never leaks them to desklets', async () => {
    const r = registryWith([]);
    const def = await r.upsert({
      label: 'Log in to Cloudflare', kind: 'login',
      target: 'https://dash.cloudflare.com/login', secretRefs: ['cloudflare.username', 'cloudflare.password'],
    });
    expect(def.secretRefs).toEqual(['cloudflare.username', 'cloudflare.password']);
    // the desklet-facing view carries no target and no secret refs
    const view = r.views().find((v) => v.id === def.id);
    expect(view).toEqual({ id: def.id, label: 'Log in to Cloudflare', kind: 'login' });
    expect(JSON.stringify(r.views())).not.toContain('cloudflare.password');
  });

  it('rejects a login action without two secret refs', async () => {
    const r = registryWith([]);
    await expect(r.upsert({ label: 'L', kind: 'login', target: 'https://x', secretRefs: ['only.one'] })).rejects.toThrow(/secret refs/);
  });

  it('removes an action by id', async () => {
    const r = registryWith([{ id: 'a', label: 'A', kind: 'app', target: 'notepad' }]);
    expect(await r.remove('a')).toBe(true);
    expect(await r.remove('a')).toBe(false);
    expect(r.list()).toHaveLength(0);
  });
});

describe('ActionsRegistry proposals (desklet → operator approval)', () => {
  it('queues a proposal without activating it, then approves it', async () => {
    const r = registryWith([]);
    const p = r.propose({ label: 'From Phone', kind: 'url', target: 'https://p' }, 'dev-1');
    expect(r.proposals()).toHaveLength(1);
    expect(r.list()).toHaveLength(0); // not active until approved
    const def = await r.approveProposal(p.proposalId);
    expect(def?.id).toBe('from-phone');
    expect(r.list()).toHaveLength(1);
    expect(r.proposals()).toHaveLength(0);
  });

  it('rejects a proposal without activating it', async () => {
    const r = registryWith([]);
    const p = r.propose({ label: 'Nope', kind: 'app', target: 'x' }, 'dev-1');
    expect(r.rejectProposal(p.proposalId)).toBe(true);
    expect(r.proposals()).toHaveLength(0);
    expect(r.list()).toHaveLength(0);
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

describe('resolveIntent for login actions', () => {
  const r = registryWith([
    { id: 'cf', label: 'Log in to Cloudflare', kind: 'login', target: 'https://dash.cloudflare.com/login', secretRefs: ['cf.user', 'cf.pass'] },
  ]);

  it('routes to the login helper with secret references, never plaintext', () => {
    const res = resolveIntent(intent('action', { actionId: 'cf' }), r)!;
    expect(res.principal).toBe('local');
    expect(res.envelope.actionId).toBe('action:cf');
    expect(res.envelope.detached).toBe(true);
    expect(res.envelope.secretRefs).toEqual(['cf.user', 'cf.pass']);
    // env carries only {{secret:…}} tokens + the URL — resolved at spawn, not here
    expect(res.envelope.env['CR_LOGIN_URL']).toBe('https://dash.cloudflare.com/login');
    expect(res.envelope.env['CR_LOGIN_USER']).toBe('{{secret:cf.user}}');
    expect(res.envelope.env['CR_LOGIN_PASS']).toBe('{{secret:cf.pass}}');
  });
});
