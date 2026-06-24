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
import { isContextRailError } from '../core/errors.js';
import { isRole } from '../core/constants.js';
import { dataPaths } from '../core/paths.js';

export interface AdminDeps {
  modeControl: ModeControl;
  maintenance: MaintenanceConfigurationInterface;
  lock: LockStateController;
  authenticator: HostAuthenticator;
  ledger: DeviceIdentityLedger;
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
      this.send(res, 404, { error: 'unknown admin route' });
    } catch (err) {
      if (isContextRailError(err)) return this.send(res, 409, err.toJSON());
      this.deps.log.error('admin api error', { err: (err as Error).message });
      this.send(res, 500, { error: 'internal error' });
    }
  }

  private status(res: ServerResponse): void {
    this.send(res, 200, {
      mode: this.deps.modeControl.mode(),
      locked: this.deps.lock.isLocked(),
      pairedDevices: this.deps.ledger.list().map((d) => ({ deviceId: d.deviceId, role: d.role, lastSeen: d.lastSeen })),
    });
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
