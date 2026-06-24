/**
 * Host Administration Station — admin API (loopback / host-only).
 *
 * Backs the operator's allowlist CLI, Maintenance control, lock/unlock, and audit
 * viewer. Allowlist edits are permitted only in Maintenance mode (the ACG
 * Maintenance Configuration Interface enforces this) and are never exposed to a
 * desklet. (SUB-HAS-067, SYS-REQ-005, IFC-HAS-055)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Logger } from '../core/logger.js';
import type { AdminApi, ModeControl } from '../core/services.js';
import type { MaintenanceConfigurationInterface } from '../acg/maintenance-configuration-interface.js';
import type { LockStateController } from '../slm/lock-state-controller.js';
import type { HostAuthenticator } from '../slm/host-authenticator.js';
import type { DeviceIdentityLedger } from '../pair/device-identity-ledger.js';
import type { RoleAssignmentManager } from '../pair/role-assignment-manager.js';
import type { ActionsRegistry, ActionDef } from '../actions/actions-registry.js';
import { isContextRailError } from '../core/errors.js';
import { isRole, ROLES, type Role } from '../core/constants.js';
import { dataPaths } from '../core/paths.js';

/** Live device controls the admin panel drives (forget / switch-role). */
export interface DeviceControl {
  connectedDeviceIds(): string[];
  disconnect(deviceId: string): void;
}

/** Context subscriber control (re-bind / drop a desklet's role-scoped stream). */
export interface SubscriberControl {
  addSubscriber(deviceId: string, role: Role): void;
  removeSubscriber(deviceId: string): void;
}

export interface AdminDeps {
  modeControl: ModeControl;
  maintenance: MaintenanceConfigurationInterface;
  lock: LockStateController;
  authenticator: HostAuthenticator;
  ledger: DeviceIdentityLedger;
  roles: RoleAssignmentManager;
  transport: DeviceControl;
  context: SubscriberControl;
  actions: ActionsRegistry;
  dataDir: string;
  log: Logger;
}

export class HostAdminApi implements AdminApi {
  constructor(private readonly deps: AdminDeps) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/admin/status') return this.status(res);
      if (req.method === 'GET' && url.pathname === '/admin/audit') return await this.audit(url, res);
      if (req.method === 'POST' && url.pathname === '/admin/maintenance') return await this.maintenance(req, res);
      if (req.method === 'POST' && url.pathname === '/admin/allowlist') return await this.allowlist(req, res);
      if (req.method === 'POST' && url.pathname === '/admin/lock') return await this.lock(req, res);
      if (req.method === 'POST' && url.pathname === '/admin/unlock') return await this.unlock(req, res);
      if (req.method === 'POST' && url.pathname === '/admin/device') return await this.device(req, res);
      if (req.method === 'GET' && url.pathname === '/admin/actions') return this.listActions(res);
      if (req.method === 'POST' && url.pathname === '/admin/actions') return await this.actions(req, res);
      this.send(res, 404, { error: 'unknown admin route' });
    } catch (err) {
      if (isContextRailError(err)) return this.send(res, 409, err.toJSON());
      this.deps.log.error('admin api error', { err: (err as Error).message });
      this.send(res, 500, { error: 'internal error' });
    }
  }

  private status(res: ServerResponse): void {
    const connected = new Set(this.deps.transport.connectedDeviceIds());
    this.send(res, 200, {
      mode: this.deps.modeControl.mode(),
      locked: this.deps.lock.isLocked(),
      roles: ROLES,
      pairedDevices: this.deps.ledger.list().map((d) => ({
        deviceId: d.deviceId,
        role: d.role,
        pairedAt: d.pairedAt,
        lastSeen: d.lastSeen,
        connected: connected.has(d.deviceId),
      })),
    });
  }

  /** Device management: forget a device, or switch its bound role. */
  private async device(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = (await body(req)) as { op?: 'forget' | 'switch-role'; deviceId?: string; role?: string };
    if (!b.deviceId || !this.deps.ledger.get(b.deviceId)) {
      return this.send(res, 404, { error: 'unknown deviceId' });
    }
    if (b.op === 'forget') {
      this.deps.context.removeSubscriber(b.deviceId);
      this.deps.roles.release(b.deviceId);
      await this.deps.ledger.remove(b.deviceId);
      this.deps.transport.disconnect(b.deviceId); // drop the live socket; it cannot re-pair
      this.deps.log.info('device forgotten', { deviceId: b.deviceId });
      return this.send(res, 200, { ok: true });
    }
    if (b.op === 'switch-role') {
      if (!b.role || !isRole(b.role)) return this.send(res, 400, { error: 'invalid role', permitted: ROLES });
      this.deps.roles.assign(b.deviceId, b.role);
      await this.deps.ledger.setRole(b.deviceId, b.role);
      this.deps.context.addSubscriber(b.deviceId, b.role);
      // Drop the socket so the desklet auto-reconnects and re-binds the new role.
      this.deps.transport.disconnect(b.deviceId);
      this.deps.log.info('device role switched', { deviceId: b.deviceId, role: b.role });
      return this.send(res, 200, { ok: true, role: b.role });
    }
    return this.send(res, 400, { error: 'op must be forget|switch-role' });
  }

  /** Current action set + pending desklet proposals (loopback / operator only). */
  private listActions(res: ServerResponse): void {
    this.send(res, 200, { actions: this.deps.actions.list(), proposals: this.deps.actions.proposals() });
  }

  /**
   * Action editing (host-only): upsert/remove a definition, or approve/reject a
   * desklet proposal. New local actions match the seeded `action:*` allow rule,
   * so they are runnable once saved — the operator review IS the gate.
   */
  private async actions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = (await body(req)) as {
      op?: 'upsert' | 'remove' | 'approve' | 'reject';
      action?: Partial<ActionDef>;
      id?: string;
      proposalId?: string;
    };
    try {
      switch (b.op) {
        case 'upsert': {
          const def = await this.deps.actions.upsert(b.action ?? {});
          return this.send(res, 200, { ok: true, action: def });
        }
        case 'remove':
          if (!b.id) return this.send(res, 400, { error: 'id required' });
          return this.send(res, 200, { removed: await this.deps.actions.remove(b.id) });
        case 'approve': {
          if (!b.proposalId) return this.send(res, 400, { error: 'proposalId required' });
          const def = await this.deps.actions.approveProposal(b.proposalId);
          return def ? this.send(res, 200, { ok: true, action: def }) : this.send(res, 404, { error: 'unknown proposal' });
        }
        case 'reject':
          if (!b.proposalId) return this.send(res, 400, { error: 'proposalId required' });
          return this.send(res, 200, { rejected: this.deps.actions.rejectProposal(b.proposalId) });
        default:
          return this.send(res, 400, { error: 'op must be upsert|remove|approve|reject' });
      }
    } catch (err) {
      return this.send(res, 400, { error: (err as Error).message });
    }
  }

  private async maintenance(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { on } = (await body(req)) as { on?: boolean };
    const ok = on ? this.deps.modeControl.enterMaintenance() : this.deps.modeControl.leaveMaintenance();
    this.send(res, ok ? 200 : 409, { mode: this.deps.modeControl.mode(), changed: ok });
  }

  private async allowlist(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = (await body(req)) as {
      op?: 'add' | 'remove' | 'list';
      adapter?: string;
      actionPattern?: string;
      effect?: 'allow' | 'deny';
      ruleId?: string;
      operator?: string;
    };
    const operator = b.operator ?? 'host-operator';
    switch (b.op) {
      case 'list':
        return this.send(res, 200, { entries: this.deps.maintenance.list() });
      case 'add':
        if (!b.adapter || !b.actionPattern) return this.send(res, 400, { error: 'adapter and actionPattern required' });
        await this.deps.maintenance.add(
          { adapter: b.adapter, actionPattern: b.actionPattern, effect: b.effect ?? 'allow', ...(b.ruleId ? { ruleId: b.ruleId } : {}) },
          operator,
        );
        return this.send(res, 200, { ok: true });
      case 'remove':
        if (!b.adapter || !b.actionPattern) return this.send(res, 400, { error: 'adapter and actionPattern required' });
        return this.send(res, 200, { removed: await this.deps.maintenance.remove(b.adapter, b.actionPattern, operator) });
      default:
        return this.send(res, 400, { error: 'op must be add|remove|list' });
    }
  }

  private async lock(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { reason } = (await body(req)) as { reason?: string };
    this.deps.lock.engage(reason ?? 'operator-command');
    this.send(res, 200, { locked: true });
  }

  private async unlock(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { passphrase } = (await body(req)) as { passphrase?: string };
    if (!passphrase || !this.deps.authenticator.authenticate(passphrase)) {
      return this.send(res, 401, { error: 'authentication failed', locked: this.deps.lock.isLocked() });
    }
    this.deps.lock.release();
    this.send(res, 200, { locked: false });
  }

  private async audit(url: URL, res: ServerResponse): Promise<void> {
    const type = url.searchParams.get('type') === 'ssh' ? 'sshAudit' : 'allowlistAudit';
    const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 50));
    const path = dataPaths(this.deps.dataDir)[type];
    let lines: unknown[] = [];
    try {
      const raw = await readFile(path, 'utf8');
      lines = raw.split('\n').filter((l) => l.trim()).slice(-limit).map((l) => JSON.parse(l));
    } catch {
      /* no audit yet */
    }
    this.send(res, 200, { type: url.searchParams.get('type') ?? 'allowlist', records: lines });
  }

  private send(res: ServerResponse, status: number, obj: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }
}

/** Validate a role string for the CLI / admin callers. */
export function validRole(role: string): boolean {
  return isRole(role);
}

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
