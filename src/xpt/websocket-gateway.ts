/**
 * WebSocket Gateway (XPT).
 *
 * Admits a desklet only after verifying its single-use session token at the HTTP
 * upgrade (closing with 401 within 200 ms when absent/invalid); supports
 * reconnect without re-pairing via the Device Identity Ledger (SYS-REQ-008);
 * rejects upgrades while Locked (SUB-XPT-044); and forwards inbound intent frames
 * to the Intent Router. (SUB-XPT-040, IFC-XPT-019, IFC-DWB-053)
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from '../core/logger.js';
import type { EventBus } from '../core/bus.js';
import type { Role } from '../core/constants.js';
import type { Intent, WsFrame } from '../core/types.js';
import type { ConnectionRegistry } from './connection-registry.js';
import type { TransportHeartbeatMonitor } from './heartbeat-monitor.js';
import type { TerminalSessionManager } from './terminal-session-manager.js';
import type { PairingTokenAuthority } from '../slm/pairing-token-authority.js';
import type { DeviceIdentityLedger } from '../pair/device-identity-ledger.js';
import { sha256Hex } from '../core/crypto.js';

let intentCounter = 0;

export interface GatewayDeps {
  registry: ConnectionRegistry;
  heartbeat: TransportHeartbeatMonitor;
  terminal: TerminalSessionManager;
  pta: PairingTokenAuthority;
  ledger: DeviceIdentityLedger;
  isLocked: () => boolean;
  onAdmit: (deskletId: string, role: Role) => void;
}

export class WebSocketGateway {
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(
    private readonly deps: GatewayDeps,
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  /** Validate + admit (or reject) an HTTP upgrade request. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'https://host');
    const token = url.searchParams.get('token') ?? '';
    const fingerprint = url.searchParams.get('fp') ?? '';
    const deviceId = url.searchParams.get('deviceId') ?? `dev-${sha256Hex(fingerprint).slice(0, 16)}`;

    if (this.deps.isLocked()) return this.reject(socket, 423, 'LOCKED');

    const admit = (role: Role) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, deviceId, role));
    };

    // 1) Fresh session token (first connect, single-use).
    if (token) {
      const v = this.deps.pta.validate(token, fingerprint);
      if (v.valid && v.role) return admit(v.role);
      return this.reject(socket, 401, v.reason ?? 'TOKEN_UNRECOGNISED');
    }

    // 2) Reconnect path: a device already in the ledger with a matching fingerprint
    //    re-binds its prior role without re-pairing. (SYS-REQ-008)
    const rec = this.deps.ledger.get(deviceId);
    if (rec && rec.fingerprint === fingerprint) return admit(rec.role);

    return this.reject(socket, 401, 'TOKEN_UNRECOGNISED');
  }

  private onConnection(ws: WebSocket, deskletId: string, role: Role): void {
    this.deps.registry.add(deskletId, ws, role);
    this.deps.ledger.touch(deskletId);
    this.log.info('desklet admitted', { deskletId, role });

    // Send the authoritative bound role BEFORE the initial context snapshot, so a
    // role switch (re-bound on reconnect) updates the client's display and the
    // following snapshot repopulates the new role's context. (Order matters: the
    // desklet clears its view on a role change.)
    try {
      ws.send(JSON.stringify({ kind: 'control', payload: { type: 'role', role }, timestamp: new Date().toISOString() }));
    } catch {
      /* socket may have closed */
    }

    this.deps.onAdmit(deskletId, role); // pushes the initial role-scoped snapshot

    ws.on('pong', () => this.deps.heartbeat.onPong(deskletId));
    ws.on('message', (data) => this.onMessage(deskletId, role, data.toString()));
    ws.on('close', () => {
      this.deps.registry.remove(deskletId);
      this.deps.terminal.close(deskletId); // tear down any embedded claude PTY
      this.bus.emit('desklet:linklost', { deskletId });
      this.log.info('desklet disconnected', { deskletId });
    });
    ws.on('error', (err) => this.log.warn('socket error', { deskletId, err: err.message }));
  }

  private onMessage(deskletId: string, role: Role, raw: string): void {
    let frame: WsFrame;
    try {
      frame = JSON.parse(raw) as WsFrame;
    } catch {
      return;
    }
    if (frame.kind === 'intent') {
      const p = (frame.payload ?? {}) as { type?: string; data?: Record<string, unknown>; targetContextObject?: string };
      const intent: Intent = {
        intentId: `int-${++intentCounter}-${Date.now()}`,
        correlationId: frame.correlationId ?? `c-${intentCounter}`,
        deskletId,
        role,
        type: p.type ?? 'unknown',
        payload: p.data ?? {},
        ...(p.targetContextObject ? { targetContextObject: p.targetContextObject } : {}),
        receiptTimestamp: new Date().toISOString(),
      };
      this.bus.emit('intent:received', intent);
    } else if (frame.kind === 'ping') {
      this.deps.heartbeat.onPong(deskletId);
    } else if (frame.kind === 'term') {
      // Embedded claude terminal — AI role only. (default-deny)
      if (role !== 'AI') return;
      const p = (frame.payload ?? {}) as { op?: string; data?: string; cols?: number; rows?: number };
      if (p.op === 'open') this.deps.terminal.open(deskletId, p.cols, p.rows);
      else if (p.op === 'input') this.deps.terminal.input(deskletId, String(p.data ?? ''));
      else if (p.op === 'resize') this.deps.terminal.resize(deskletId, Number(p.cols), Number(p.rows));
      else if (p.op === 'close') this.deps.terminal.close(deskletId);
    }
  }

  private reject(socket: Duplex, status: number, reason: string): void {
    const text = { 401: 'Unauthorized', 423: 'Locked' }[status] ?? 'Bad Request';
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\n` +
        'Content-Type: application/json\r\n' +
        'Connection: close\r\n\r\n' +
        JSON.stringify({ error: reason }),
    );
    socket.destroy();
    this.log.warn('upgrade rejected', { status, reason });
  }

  closeAll(): void {
    for (const conn of this.deps.registry.list()) {
      try {
        conn.socket.close(1012, 'locked');
      } catch {
        /* ignore */
      }
      this.deps.registry.remove(conn.deskletId);
    }
  }
}
