/**
 * Host Core Runtime verification tests.
 * Maps to SUB-HCR-016 (defined transitions only), SUB-HCR-017 (degrade on
 * subsystem failure), SUB-HCR-019 (boot order / BOOT_FAILED), ARC-REQ-006 (lock overlay).
 */
import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/core/bus.js';
import { createLogger } from '../src/core/logger.js';
import { ModeStateMachine } from '../src/hcr/mode-state-machine.js';
import { StartupOrchestrator } from '../src/hcr/startup-orchestrator.js';
import type { Subsystem } from '../src/core/subsystem.js';

const log = createLogger('test');

function fakeSub(name: string, behaviour: Partial<Subsystem> = {}): Subsystem {
  return {
    name,
    start: behaviour.start ?? (async () => undefined),
    stop: behaviour.stop ?? (async () => undefined),
    health: behaviour.health ?? (() => ({ status: 'nominal' })),
  };
}

describe('ModeStateMachine (SUB-HCR-016)', () => {
  it('enters Nominal only via bootComplete and rejects undefined transitions', () => {
    const bus = new EventBus();
    const msm = new ModeStateMachine(bus, log);
    expect(msm.mode()).toBe('Initialising');
    msm.bootComplete();
    expect(msm.mode()).toBe('Nominal');

    expect(msm.transition('Maintenance', 't')).toBe(true);
    // Maintenance -> Locked is not a defined transition.
    expect(msm.transition('Locked', 't')).toBe(false);
    expect(msm.mode()).toBe('Maintenance');
  });

  it('degrades on subsystem failure and recovers (SUB-HCR-017)', () => {
    const bus = new EventBus();
    const msm = new ModeStateMachine(bus, log);
    msm.bootComplete();
    bus.emit('subsystem:failed', { subsystem: 'X', timestamp: 't' });
    expect(msm.mode()).toBe('Degraded');
    bus.emit('subsystem:recovered', { subsystem: 'X', timestamp: 't' });
    expect(msm.mode()).toBe('Nominal');
  });

  it('lock overlay supersedes and restores the prior mode (ARC-REQ-006)', () => {
    const bus = new EventBus();
    const msm = new ModeStateMachine(bus, log);
    msm.bootComplete();
    bus.emit('lock:engaged', { reason: 'r', timestamp: 't' });
    expect(msm.mode()).toBe('Locked');
    bus.emit('lock:released', { timestamp: 't' });
    expect(msm.mode()).toBe('Nominal');
  });
});

describe('StartupOrchestrator (SUB-HCR-019)', () => {
  it('boots subsystems in order and emits boot:complete', async () => {
    const bus = new EventBus();
    const order: string[] = [];
    const subs = ['A', 'B', 'C'].map((n) => fakeSub(n, { start: async () => void order.push(n) }));
    let completed: string[] = [];
    bus.on('boot:complete', (p) => (completed = p.subsystems));

    const orch = new StartupOrchestrator(bus, log);
    const names = await orch.boot(subs);
    expect(order).toEqual(['A', 'B', 'C']);
    expect(names).toEqual(['A', 'B', 'C']);
    expect(completed).toEqual(['A', 'B', 'C']);
  });

  it('aborts with BOOT_FAILED when a subsystem fails to start', async () => {
    const bus = new EventBus();
    let failed: { subsystem: string } | undefined;
    bus.on('boot:failed', (p) => (failed = p));
    const subs = [
      fakeSub('ok'),
      fakeSub('bad', { start: async () => { throw new Error('nope'); } }),
      fakeSub('never', { start: async () => { throw new Error('should not start'); } }),
    ];
    const orch = new StartupOrchestrator(bus, log);
    await expect(orch.boot(subs)).rejects.toMatchObject({ code: 'BOOT_FAILED' });
    expect(failed?.subsystem).toBe('bad');
  });
});
