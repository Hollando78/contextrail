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
import { readFile, appendFile } from 'node:fs/promises';
import { BaseSubsystem, type RuntimeContext, type SubsystemHealth } from '../core/subsystem.js';
import { SERVICE } from '../core/services.js';
import { TIMING, type Role } from '../core/constants.js';
import type { RoleProjection, CommandOutcome } from '../core/types.js';
import { ContextObjectRegistry } from './context-object-registry.js';
import { RoleScopeFilter } from './role-scope-filter.js';
import { EventBusAdapter, type WorkspaceEvent } from './event-bus-adapter.js';
import { dataPaths } from '../core/paths.js';
import { recentLogs } from '../core/logger.js';
import { SystemMetrics } from '../host/system-metrics.js';
import type { DeviceIdentityLedger } from '../pair/device-identity-ledger.js';
import type { LocalTransportServer } from '../xpt/local-transport-server.js';

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
  private readonly metrics = new SystemMetrics(this.config.dataDir);
  private readonly unsubscribers: Array<() => void> = [];

  /** Capture role: operator notes/snippets, persisted to data/captures.jsonl. */
  private captures: Array<{ id: string; text: string; at: string }> = [];
  private captureSeq = 0;
  /** AI role: the on-host assistant conversation transcript. */
  private aiHistory: Array<{ role: 'you' | 'assistant'; text: string; at: string }> = [];

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
    await this.loadCaptures();
    this.seedAssistant();

    // Stream the customisable action set to Actions desklets, and re-stream on change.
    const actions = this.services.tryGet<import('../actions/actions-registry.js').ActionsRegistry>(SERVICE.Actions);
    if (actions) {
      this.publishActions(actions.views());
      actions.onChange(() => this.publishActions(actions.views()));
    }

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
    this.pulseTimer = setInterval(
      () => void this.pulse().catch((e) => this.log.warn('pulse failed', { err: (e as Error).message })),
      pulseEvery,
    );
    this.pulseTimer.unref?.();

    this.services.set(SERVICE.ContextStore, this);
    this.log.info('workspace context store ready', { objects: this.registry.list().length, pulseMs: pulseEvery });
  }

  /** Host-status heartbeat + resource-monitor metrics (for the Status role). */
  private async pulse(): Promise<void> {
    if (this.locked) return; // no context streamed while locked
    const m = await this.metrics.sample();
    const ledger = this.services.tryGet<DeviceIdentityLedger>(SERVICE.DeviceLedger);
    const transport = this.services.tryGet<LocalTransportServer>(SERVICE.Transport);
    const ledgerDevices = ledger?.list() ?? [];
    const paired = ledgerDevices.length;
    const live = transport?.connectedDeviceIds().length ?? 0;

    this.ingest({
      type: 'raw',
      writes: [
        { attributePath: 'workspace.hostPulse', newValue: { ts: new Date().toISOString(), uptimeSec: Math.round((Date.now() - this.startedAt) / 1000) }, sourceEventType: 'pulse' },
        // Keep the paired-device list (Status + Project) live as roles change.
        { attributePath: 'workspace.pairedDevices', newValue: ledgerDevices.map((d) => ({ deviceId: d.deviceId, role: d.role })), sourceEventType: 'pulse' },
        { attributePath: 'workspace.cpu', newValue: m.cpu, sourceEventType: 'metrics' },
        { attributePath: 'workspace.memory', newValue: m.memory, sourceEventType: 'metrics' },
        { attributePath: 'workspace.disk', newValue: m.disk, sourceEventType: 'metrics' },
        { attributePath: 'workspace.uptime', newValue: m.uptimeSec, sourceEventType: 'metrics' },
        { attributePath: 'workspace.load', newValue: m.load1, sourceEventType: 'metrics' },
        { attributePath: 'workspace.cores', newValue: m.cores, sourceEventType: 'metrics' },
        { attributePath: 'workspace.cpuModel', newValue: m.cpuModel, sourceEventType: 'metrics' },
        { attributePath: 'workspace.platform', newValue: m.platform, sourceEventType: 'metrics' },
        { attributePath: 'workspace.hostProc', newValue: { rssMB: m.procRssMB }, sourceEventType: 'metrics' },
        { attributePath: 'workspace.devices', newValue: { live, paired }, sourceEventType: 'metrics' },
        // Live host log tail for the Logs role (newest last).
        { attributePath: 'workspace.logs', newValue: recentLogs(40), sourceEventType: 'logs' },
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
      ],
    });
  }

  /** Publish the customisable action set (rendered as tiles by Actions desklets). */
  private publishActions(views: unknown): void {
    this.ingest({
      type: 'raw',
      writes: [{ attributePath: 'workspace.availableActions', newValue: views, sourceEventType: 'actions' }],
    });
  }

  // --- Capture role ------------------------------------------------------------

  /** Restore persisted captures from disk so the Capture desklet sees its notes. */
  private async loadCaptures(): Promise<void> {
    const file = dataPaths(this.config.dataDir).captures;
    try {
      const raw = await readFile(file, 'utf8');
      this.captures = raw
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
        .filter((c) => c && typeof c.text === 'string');
      this.captureSeq = this.captures.length;
      this.log.info('captures loaded', { count: this.captures.length });
    } catch {
      this.captures = [];
    }
    this.publishCaptures();
  }

  /** Append a captured note (from a Capture desklet intent) and persist it. */
  addCapture(text: string): { id: string; text: string; at: string } {
    const t = text.trim().slice(0, 2000);
    if (!t) throw new Error('empty capture');
    const cap = { id: `cap-${++this.captureSeq}-${Date.now().toString(36)}`, text: t, at: new Date().toISOString() };
    this.captures.push(cap);
    if (this.captures.length > 500) this.captures = this.captures.slice(-500);
    const file = dataPaths(this.config.dataDir).captures;
    void appendFile(file, JSON.stringify(cap) + '\n').catch((e) =>
      this.log.warn('capture persist failed', { err: (e as Error).message }),
    );
    this.publishCaptures();
    return cap;
  }

  /** Stream the capture list to Capture desklets (most recent first). */
  private publishCaptures(): void {
    this.ingest({
      type: 'raw',
      writes: [{ attributePath: 'workspace.captures', newValue: [...this.captures].reverse().slice(0, 100), sourceEventType: 'capture' }],
    });
  }

  // --- AI role: on-host workspace assistant ------------------------------------

  /** Seed the assistant greeting + initial suggestion chips. */
  private seedAssistant(): void {
    if (!this.aiHistory.length) {
      this.aiHistory.push({
        role: 'assistant',
        text: 'ContextRail assistant ready. Ask about host status, connected devices, or available actions.',
        at: new Date().toISOString(),
      });
    }
    this.publishAi();
  }

  /**
   * Answer an AI-role query. A deterministic, on-host assistant: it reasons over
   * the live workspace context (no external model, no network) so the AI desklet
   * is fully functional out of the box. The single `answerFor` seam is where a
   * real LLM call would slot in if an operator wires one up.
   */
  runAssistant(query: string): { answer: string } {
    const q = query.trim().slice(0, 2000);
    if (!q) throw new Error('empty query');
    const now = new Date().toISOString();
    this.aiHistory.push({ role: 'you', text: q, at: now });
    const answer = this.answerFor(q);
    this.aiHistory.push({ role: 'assistant', text: answer, at: new Date().toISOString() });
    if (this.aiHistory.length > 100) this.aiHistory = this.aiHistory.slice(-100);
    this.publishAi();
    return { answer };
  }

  private publishAi(): void {
    this.ingest({
      type: 'raw',
      writes: [
        { attributePath: 'workspace.aiContext', newValue: this.aiHistory.slice(-50), sourceEventType: 'ai' },
        {
          attributePath: 'workspace.aiSuggestions',
          newValue: [
            { label: 'Host status', query: 'status' },
            { label: 'Connected devices', query: 'devices' },
            { label: 'Available actions', query: 'actions' },
          ],
          sourceEventType: 'ai',
        },
      ],
    });
  }

  /** Read a current workspace attribute value from the authoritative registry. */
  private attr<T>(name: string): T | undefined {
    return this.registry.get('workspace')?.attributes[name]?.value as T | undefined;
  }

  /** The on-host assistant's reasoning over live context. */
  private answerFor(query: string): string {
    const ql = query.toLowerCase();
    const mode = this.attr<string>('hostMode') ?? 'unknown';
    const cpu = this.attr<number>('cpu');
    const mem = this.attr<{ pct: number; usedMB: number; totalMB: number }>('memory');
    const disk = this.attr<{ pct: number; usedGB: number; totalGB: number }>('disk');
    const dev = this.attr<{ live: number; paired: number }>('devices');
    const pulse = this.attr<{ uptimeSec: number }>('hostPulse');
    const cores = this.attr<number>('cores');
    const platform = this.attr<string>('platform');
    const actions = this.attr<Array<{ label: string }>>('availableActions') ?? [];

    const gb1 = (mb: number) => (mb / 1024).toFixed(1);
    const uptime = (sec?: number) => {
      if (typeof sec !== 'number') return '—';
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return (h ? `${h}h ` : '') + `${m}m`;
    };
    const statusLine = `Host is ${mode}. CPU ${cpu ?? '–'}%${mem ? `, memory ${mem.pct}% (${gb1(mem.usedMB)}/${gb1(mem.totalMB)} GB)` : ''}${disk ? `, disk ${disk.pct}%` : ''}. Uptime ${uptime(pulse?.uptimeSec)}.`;

    if (/\b(help|what can you|capab|how do)\b/.test(ql)) {
      return 'I report on this host from its live context. Try "status" for resources, "devices" for who is paired, or "actions" to see what the Actions role can run. I run entirely on-host — no data leaves this machine.';
    }
    if (/\b(device|paired|connected|phone|tablet|who)\b/.test(ql)) {
      return dev
        ? `${dev.live} device${dev.live === 1 ? '' : 's'} live, ${dev.paired} paired in total.`
        : 'Device information is not available yet.';
    }
    if (/\b(action|run|launch|open|do|tool)\b/.test(ql)) {
      return actions.length
        ? `The Actions role can run: ${actions.map((a) => a.label).join(', ')}.`
        : 'No actions are configured. Edit config/actions.json on the host to add some.';
    }
    if (/\b(status|health|cpu|memory|ram|disk|load|resource|uptime|how.*(doing|running|going))\b/.test(ql)) {
      return statusLine + (cores ? ` ${cores} cores, ${platform}.` : '');
    }
    return `I'm a workspace assistant for this host. ${statusLine} Ask me about "devices" or "actions", or type "help".`;
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
        // Default map scopes this to Status + Project (the operator dashboard).
      });
      this.registry.setStale(true);
      this.log.info('rebuilt context from ledger', { devices: devices.length });
    } catch {
      this.log.info('no prior ledger to rebuild from (fresh start)');
    }
  }
}
