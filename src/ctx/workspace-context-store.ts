/**
 * Workspace Context Store (CTX) subsystem.
 *
 * Owns the single authoritative workspace context model and streams role-scoped
 * projections to subscribed desklets. Composes the Context Object Registry, Role
 * Scope Filter, and Event Bus Adapter. (FN-FN-007/008, SYS-REQ-011/012)
 *
 * - Publishes ContextUpdated within 30 ms of a CommandOutcome. (IFC-CTX-021)
 * - Emits role-scoped projections (consumed by the transport) within budget.
 * - Ceases projections within 1 s of Lock; resumes within 2 s of unlock. (SUB-CTX-033)
 * - In Degraded mode serves the last snapshot and marks attributes stale. (SUB-CTX-034)
 * - Rebuilds the snapshot from the Device Identity Ledger on restart. (SUB-CTX-080)
 */
import { readFile } from 'node:fs/promises';
import { BaseSubsystem, type RuntimeContext, type SubsystemHealth } from '../core/subsystem.js';
import { SERVICE } from '../core/services.js';
import { TIMING, type Role } from '../core/constants.js';
import type { RoleProjection, CommandOutcome } from '../core/types.js';
import { ContextObjectRegistry } from './context-object-registry.js';
import { RoleScopeFilter } from './role-scope-filter.js';
import { EventBusAdapter, type WorkspaceEvent } from './event-bus-adapter.js';
import { dataPaths } from '../core/paths.js';

export class WorkspaceContextStore extends BaseSubsystem {
  readonly name = 'WorkspaceContextStore';

  private readonly filter = new RoleScopeFilter();
  private readonly registry: ContextObjectRegistry;
  private readonly adapter: EventBusAdapter;
  /** deskletId -> bound role (subscribers receiving projections). */
  private readonly subscribers = new Map<string, Role>();
  private locked = false;
  private degraded = false;
  private pulseTimer: NodeJS.Timeout | undefined;
  private readonly startedAt = Date.now();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(ctx: RuntimeContext) {
    super(ctx);
    this.init();
    this.registry = new ContextObjectRegistry((attr, explicit) => this.filter.rolesFor(attr, explicit));
    this.adapter = new EventBusAdapter(
      this.registry,
      this.log.child('ingest'),
      (objectId, fields, version) => this.onRegistryUpdate(objectId, fields, version),
      (dropped) => this.bus.emit('context:overflow', { dropped, timestamp: new Date().toISOString() }),
    );
  }

  override async start(): Promise<void> {
    await this.rebuildFromLedger();
    this.seedInitialContext();

    this.unsubscribers.push(
      this.bus.on('command:outcome', (o) => this.onCommandOutcome(o)),
      this.bus.on('desklet:paired', (p) => this.addSubscriber(p.deskletId, p.role as Role)),
      this.bus.on('desklet:linklost', (p) => this.subscribers.delete(p.deskletId)),
      this.bus.on('lock:engaged', () => this.setLocked(true)),
      this.bus.on('lock:released', () => this.setLocked(false)),
      this.bus.on('mode:changed', (m) => this.onModeChanged(m.to)),
    );
    // Periodic host-status pulse (all roles) at half the desklet staleness window,
    // so a healthy link keeps receiving fresh frames and the staleness indicator
    // reflects real link/host health rather than merely-unchanging data. (SUB-KWD-068)
    const pulseEvery = Math.floor(TIMING.STALENESS_INDICATOR_MS / 2);
    this.pulseTimer = setInterval(() => this.pulse(), pulseEvery);
    this.pulseTimer.unref?.();

    this.services.set(SERVICE.ContextStore, this);
    this.log.info('workspace context store ready', { objects: this.registry.list().length, pulseMs: pulseEvery });
  }

  /** Emit a lightweight host-status heartbeat visible to every role. */
  private pulse(): void {
    if (this.locked) return; // no context streamed while locked
    this.ingest({
      type: 'raw',
      writes: [
        {
          attributePath: 'workspace.hostPulse',
          newValue: { ts: new Date().toISOString(), uptimeSec: Math.round((Date.now() - this.startedAt) / 1000) },
          sourceEventType: 'pulse',
        },
      ],
    });
  }

  /** Seed baseline host context so a freshly-joined desklet always renders something. */
  private seedInitialContext(): void {
    this.ingest({
      type: 'raw',
      writes: [
        { attributePath: 'workspace.hostMode', newValue: 'Nominal', sourceEventType: 'seed' },
        { attributePath: 'workspace.health', newValue: 'host online', sourceEventType: 'seed' },
        { attributePath: 'workspace.toolStatus', newValue: { host: 'running' }, sourceEventType: 'seed' },
        { attributePath: 'workspace.activeProject', newValue: 'ContextRail', sourceEventType: 'seed' },
        { attributePath: 'workspace.availableActions', newValue: ['launch-ide', 'open-project-urls', 'restore-layout'], sourceEventType: 'seed' },
      ],
    });
  }

  override async stop(): Promise<void> {
    if (this.pulseTimer) clearInterval(this.pulseTimer);
    for (const off of this.unsubscribers.splice(0)) off();
    this.subscribers.clear();
  }

  override health(): SubsystemHealth {
    return {
      status: this.degraded ? 'degraded' : 'nominal',
      detail: { subscribers: this.subscribers.size, pending: this.adapter.pending, overflows: this.adapter.overflows },
    };
  }

  // --- Public API used by other subsystems ------------------------------------

  /** Ingest a workspace event from a producer (adapters, OS watchers, executor). */
  ingest(event: WorkspaceEvent): void {
    this.adapter.ingest(event);
  }

  /** A full role-scoped snapshot projection — used by the transport for the join frame. */
  snapshotForRole(deskletId: string, role: Role): RoleProjection | null {
    if (this.locked) return null;
    return this.filter.snapshot(deskletId, role, this.registry.all(), this.degraded);
  }

  addSubscriber(deskletId: string, role: Role): void {
    this.subscribers.set(deskletId, role);
    // Push an initial full snapshot so a freshly-joined desklet renders immediately.
    const snap = this.snapshotForRole(deskletId, role);
    if (snap) this.bus.emit('context:projection', snap);
  }

  removeSubscriber(deskletId: string): void {
    this.subscribers.delete(deskletId);
  }

  // --- Internal ----------------------------------------------------------------

  private onCommandOutcome(o: CommandOutcome): void {
    // Translate a command outcome into a context write + history entry, then the
    // adapter publishes ContextUpdated (well within the 30 ms budget, IFC-CTX-021).
    this.ingest({
      type: 'command-outcome',
      writes: [
        {
          attributePath: 'workspace.lastOutcome',
          newValue: { intentId: o.intentId, status: o.status, exitCode: o.exitCode },
          sourceEventType: 'command-outcome',
          roles: ['Status', 'Logs'],
        },
      ],
      history: {
        intentId: o.intentId,
        status: o.status,
        exitCode: o.exitCode,
        elapsedMs: o.elapsedMs,
        at: new Date().toISOString(),
      },
    });
  }

  private onRegistryUpdate(objectId: string, fields: string[], version: number): void {
    const obj = this.registry.get(objectId);
    if (!obj) return;

    // IFC-CTX-021: publish ContextUpdated for the intent router / subscribers.
    this.bus.emit('context:updated', {
      contextObjectId: objectId,
      deltaFields: Object.fromEntries(fields.map((f) => [f, obj.attributes[f]?.value])),
      version,
    });

    // While Locked, no context is streamed to any desklet. (SUB-CTX-033, SYS-REQ-003)
    if (this.locked) return;

    for (const [deskletId, role] of this.subscribers) {
      const projection = this.filter.project(
        deskletId,
        role,
        obj,
        fields,
        this.registry.all(),
        this.degraded,
      );
      if (projection) this.bus.emit('context:projection', projection);
    }
  }

  private setLocked(locked: boolean): void {
    this.locked = locked;
    this.log.info(locked ? 'context streaming suspended (locked)' : 'context streaming resumed', {});
    if (!locked) {
      // Resume: re-push current snapshots to all subscribers. (SUB-CTX-033)
      for (const [deskletId, role] of this.subscribers) {
        const snap = this.snapshotForRole(deskletId, role);
        if (snap) this.bus.emit('context:projection', snap);
      }
    }
  }

  /** Reflect the host mode into context (so desklets see it) and track Degraded. */
  private onModeChanged(to: string): void {
    this.ingest({
      type: 'raw',
      writes: [{ attributePath: 'workspace.hostMode', newValue: to, sourceEventType: 'mode-change' }],
    });
    this.setDegraded(to === 'Degraded');
  }

  private setDegraded(degraded: boolean): void {
    if (degraded === this.degraded) return;
    this.degraded = degraded;
    this.registry.setStale(degraded);
    this.log.info('degraded state changed', { degraded });
  }

  /**
   * Rebuild the authoritative snapshot after an unplanned restart. Pairing state
   * is recovered from the Device Identity Ledger; workspace attributes start
   * stale until the first fresh event per integration. (SUB-CTX-080)
   */
  private async rebuildFromLedger(): Promise<void> {
    this.registry.clear();
    const paths = dataPaths(this.config.dataDir);
    try {
      const raw = await readFile(paths.ledger, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim());
      const devices = lines.map((l) => JSON.parse(l)).filter((r) => r && r.deviceId);
      this.registry.write({
        attributePath: 'workspace.pairedDevices',
        newValue: devices.map((d: { deviceId: string; role: string }) => ({ deviceId: d.deviceId, role: d.role })),
        sourceEventType: 'rebuild',
        roles: ['Status'],
      });
      this.registry.setStale(true);
      this.log.info('rebuilt context from ledger', { devices: devices.length });
    } catch {
      this.log.info('no prior ledger to rebuild from (fresh start)');
    }
  }
}
