/**
 * Role-view verification: the data sources and intents behind the Project,
 * Logs, Capture, and AI desklet views.
 * Maps to SYS-REQ-007 (one role per desklet, default-deny), SYS-REQ-011
 * (role-scoped context), FN-FN-010 (in-process data intents).
 */
import { describe, it, expect } from 'vitest';
import { RoleScopeFilter } from '../src/ctx/role-scope-filter.js';
import { EventBus } from '../src/core/bus.js';
import { createLogger } from '../src/core/logger.js';
import { IntentDispatcher } from '../src/int/intent-dispatcher.js';
import { buildDataHandlers } from '../src/int/data-intent-handlers.js';
import type { Intent } from '../src/core/types.js';
import type { Role } from '../src/core/constants.js';

const log = createLogger('test');

describe('Role scoping for the new views (SYS-REQ-011)', () => {
  const filter = new RoleScopeFilter();
  it('scopes capture/log/ai attributes to their role only', () => {
    expect(filter.rolesFor('captures')).toEqual(['Capture']);
    expect(filter.rolesFor('notes')).toEqual(['Capture']);
    expect(filter.rolesFor('logs')).toEqual(['Logs']);
    expect(filter.rolesFor('aiContext')).toEqual(['AI']);
    expect(filter.rolesFor('aiSuggestions')).toEqual(['AI']);
  });
  it('shares paired-device + host vitals with the Project dashboard', () => {
    expect(filter.rolesFor('pairedDevices')).toContain('Project');
    expect(filter.rolesFor('cores')).toContain('Project');
    expect(filter.rolesFor('platform')).toContain('Project');
    expect(filter.rolesFor('load')).toContain('Project');
  });
  it('keeps the resource meters Status-only', () => {
    expect(filter.rolesFor('cpu')).toEqual(['Status']);
    expect(filter.rolesFor('memory')).toEqual(['Status']);
    expect(filter.rolesFor('disk')).toEqual(['Status']);
  });
});

describe('Data intents are role-scoped (FN-FN-010, default-deny)', () => {
  const mkIntent = (type: string, role: Role, payload: Record<string, unknown>): Intent => ({
    intentId: `i-${type}`,
    correlationId: `c-${type}`,
    deskletId: 'd1',
    role,
    type,
    payload,
    receiptTimestamp: new Date().toISOString(),
  });

  function dispatcherWith(store: { addCapture: (t: string) => void; runAssistant: (q: string) => void }, actions?: any) {
    const bus = new EventBus();
    const policy = { evaluate: () => ({ decision: 'ALLOW', permitId: 'p' }) } as never;
    const dispatcher = new IntentDispatcher(
      bus,
      { policy, executorFor: () => undefined, dataHandlers: buildDataHandlers(store, actions) },
      log,
      5,
    );
    return { bus, dispatcher };
  }

  async function outcomeOf(type: string, role: Role, payload: Record<string, unknown>, store: any, actions?: any) {
    const { bus, dispatcher } = dispatcherWith(store, actions);
    let status = '';
    bus.on('intent:outcome', (o) => { status = o.status; });
    await dispatcher.handle(mkIntent(type, role, payload));
    return status;
  }

  it('captures a note from a Capture desklet and stores it', async () => {
    const seen: string[] = [];
    const store = { addCapture: (t: string) => seen.push(t), runAssistant: () => {} };
    const status = await outcomeOf('capture', 'Capture', { text: 'hello' }, store);
    expect(status).toBe('SUCCESS');
    expect(seen).toEqual(['hello']);
  });

  it('denies a capture from a non-Capture role and stores nothing', async () => {
    const seen: string[] = [];
    const store = { addCapture: (t: string) => seen.push(t), runAssistant: () => {} };
    const status = await outcomeOf('capture', 'Status', { text: 'hello' }, store);
    expect(status).toBe('DENIED');
    expect(seen).toHaveLength(0);
  });

  it('rejects an empty capture', async () => {
    const store = { addCapture: () => {}, runAssistant: () => {} };
    expect(await outcomeOf('capture', 'Capture', { text: '   ' }, store)).toBe('FAILURE');
  });

  it('answers an AI query only for an AI desklet', async () => {
    const asked: string[] = [];
    const store = { addCapture: () => {}, runAssistant: (q: string) => asked.push(q) };
    expect(await outcomeOf('ai-query', 'AI', { query: 'status' }, store)).toBe('SUCCESS');
    expect(asked).toEqual(['status']);
    expect(await outcomeOf('ai-query', 'Capture', { query: 'status' }, store)).toBe('DENIED');
    expect(asked).toHaveLength(1);
  });

  it('lets an Actions desklet propose an action, but not an SSH one', async () => {
    const proposed: any[] = [];
    const store = { addCapture: () => {}, runAssistant: () => {} };
    const actions = { propose: (input: any) => { proposed.push(input); return { proposalId: 'p1' }; } };
    expect(await outcomeOf('action-propose', 'Actions', { label: 'X', kind: 'url', target: 'https://x' }, store, actions)).toBe('SUCCESS');
    expect(proposed).toHaveLength(1);
    // wrong role and ssh kind are both denied, and neither is queued
    expect(await outcomeOf('action-propose', 'Status', { label: 'X', kind: 'url', target: 'https://x' }, store, actions)).toBe('DENIED');
    expect(await outcomeOf('action-propose', 'Actions', { label: 'X', kind: 'ssh', command: 'deploy', host: 'p' }, store, actions)).toBe('DENIED');
    expect(proposed).toHaveLength(1);
  });
});
