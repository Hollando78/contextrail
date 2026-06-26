/**
 * Local Transport Server (XPT) subsystem.
 *
 * A single Node process embedding the HTTPS Static Asset Server and the WebSocket
 * Gateway on the same TLS port, with an in-process Connection Registry, Heartbeat
 * Monitor, and Channel Multiplexer. A separate loopback HTTP server answers the
 * subsystem /health endpoint. (ARC-REQ-014, SUB-XPT-039..045, IFC-XPT-020)
 *
 * - Closes all connections within 1 s of Lock and rejects upgrades until unlock. (SUB-XPT-044)
 * - Continues serving heartbeats and last context in Degraded mode. (SUB-XPT-045)
 */
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { watchFile, unwatchFile, readFileSync } from 'node:fs';
import { BaseSubsystem, type RuntimeContext, type SubsystemHealth } from '../core/subsystem.js';
import { SERVICE } from '../core/services.js';
import type { Role } from '../core/constants.js';
import type { RoleProjection } from '../core/types.js';
import { resolveTls, type TlsMaterial } from './tls.js';
import { ConnectionRegistry } from './connection-registry.js';
import { ChannelMultiplexer } from './channel-multiplexer.js';
import { TransportHeartbeatMonitor } from './heartbeat-monitor.js';
import { TerminalSessionManager } from './terminal-session-manager.js';
import { MouseControl } from '../has/mouse-control.js';
import { HttpStaticAssetServer } from './http-static-asset-server.js';
import { WebSocketGateway } from './websocket-gateway.js';
import type { LockStateController } from '../slm/lock-state-controller.js';
import type { ContextAccessGuard } from '../slm/context-access-guard.js';
import type { PairingTokenAuthority } from '../slm/pairing-token-authority.js';
import type { DeviceIdentityLedger } from '../pair/device-identity-ledger.js';
import type { DeskletPairingAndIdentity } from '../pair/desklet-pairing-and-identity.js';
import type { WorkspaceContextStore } from '../ctx/workspace-context-store.js';

export class LocalTransportServer extends BaseSubsystem {
  readonly name = 'LocalTransportServer';

  private tls!: TlsMaterial;
  private tlsTrusted = false;
  private httpsServer!: HttpsServer;
  private loopbackServer!: HttpServer;
  private registry!: ConnectionRegistry;
  private mux!: ChannelMultiplexer;
  private heartbeat!: TransportHeartbeatMonitor;
  private terminal!: TerminalSessionManager;
  private mouse!: MouseControl;
  private gateway!: WebSocketGateway;
  private statics!: HttpStaticAssetServer;
  private locked = false;
  private degraded = false;
  private readonly offs: Array<() => void> = [];

  constructor(ctx: RuntimeContext) {
    super(ctx);
    this.init();
  }

  override async start(): Promise<void> {
    const lock = this.services.get<LockStateController>(SERVICE.LockState);
    const guard = this.services.get<ContextAccessGuard>(SERVICE.ContextAccessGuard);
    const pta = this.services.get<PairingTokenAuthority>(SERVICE.PairingTokenAuthority);
    const ledger = this.services.get<DeviceIdentityLedger>(SERVICE.DeviceLedger);
    const ctx = this.services.get<WorkspaceContextStore>(SERVICE.ContextStore);
    const pairing = this.services.get<DeskletPairingAndIdentity>(SERVICE.Pairing);

    const tls = resolveTls({
      commonName: this.config.tls.commonName,
      dataDir: this.dataDir,
      persist: this.config.tls.persist !== false,
      certPath: this.config.tls.certPath,
      keyPath: this.config.tls.keyPath,
      publicHost: this.config.tls.publicHost,
    });
    this.tls = tls.material;
    this.tlsTrusted = tls.trusted;
    this.registry = new ConnectionRegistry();
    this.mux = new ChannelMultiplexer(this.registry, guard, this.log.child('mux'));
    this.heartbeat = new TransportHeartbeatMonitor(this.registry, ledger, this.log.child('hbm'), (id) =>
      this.bus.emit('desklet:linklost', { deskletId: id }),
    );
    this.terminal = new TerminalSessionManager((id, frame) => this.mux.send(id, frame), this.log.child('term'));
    this.mouse = new MouseControl(this.log.child('mouse'));

    this.statics = new HttpStaticAssetServer(
      pairing,
      this.log.child('static'),
      () => (this.tls.lanAddresses.length ? this.tls.lanAddresses : [this.config.host]),
      this.config.port,
    );

    this.gateway = new WebSocketGateway(
      {
        registry: this.registry,
        heartbeat: this.heartbeat,
        terminal: this.terminal,
        mouse: this.mouse,
        pta,
        ledger,
        isLocked: () => this.locked || lock.isLocked(),
        onAdmit: (deskletId, role) => ctx.addSubscriber(deskletId, role as Role),
      },
      this.bus,
      this.log.child('gateway'),
    );

    // HTTPS server: desklet + device pairing on the LAN-facing port; upgrades to the gateway.
    this.httpsServer = createHttpsServer({ key: this.tls.key, cert: this.tls.cert }, (req, res) => {
      void this.statics.handle(req, res, { loopback: false });
    });
    this.httpsServer.on('upgrade', (req, socket, head) => this.gateway.handleUpgrade(req, socket, head));

    // Hot-reload a renewed CA cert without a restart: watch the cert file and
    // swap the server's secure context when it changes. (Makes cert renewal seamless.)
    if (this.config.tls.certPath && this.config.tls.keyPath) {
      this.watchCert(this.config.tls.certPath, this.config.tls.keyPath);
    }

    // Loopback HTTP server: operator console (admin.html), /pair/new, /health, and
    // the Host Admin Station's /admin/* routes — all host-only.
    this.loopbackServer = createHttpServer((req, res) => {
      const admin = this.services.tryGet<import('../core/services.js').AdminApi>(SERVICE.AdminApi);
      if (admin && (req.url ?? '').startsWith('/admin')) {
        void admin.handle(req, res);
        return;
      }
      void this.statics.handle(req, res, { loopback: true });
    });
    // Allow ws:// upgrades on loopback so a localhost dev tab can connect without TLS.
    this.loopbackServer.on('upgrade', (req, socket, head) => this.gateway.handleUpgrade(req, socket, head));

    await this.listen(this.httpsServer, this.config.port, this.config.host);
    await this.listen(this.loopbackServer, this.config.loopbackPort, '127.0.0.1');

    this.heartbeat.start();
    this.wireBus();
    this.services.set(SERVICE.Transport, this);

    const primary = this.tls.lanAddresses[0] ?? this.config.host;
    this.log.info('local transport server listening', {
      url: this.config.port === 443 ? `https://${primary}` : `https://${primary}:${this.config.port}`,
      lan: this.tls.lanAddresses,
      loopbackPort: this.config.loopbackPort,
      cert: this.tlsTrusted ? 'CA-signed (trusted)' : 'self-signed',
    });
  }

  override async stop(): Promise<void> {
    for (const off of this.offs.splice(0)) off();
    if (this.watchedCertPath) unwatchFile(this.watchedCertPath);
    this.heartbeat?.stop();
    this.terminal?.closeAll();
    this.mouse?.stop();
    this.gateway?.closeAll();
    await Promise.all([closeServer(this.httpsServer), closeServer(this.loopbackServer)]);
  }

  private watchedCertPath: string | undefined;

  /** Watch the cert file and swap the TLS secure context when it's renewed. */
  private watchCert(certPath: string, keyPath: string): void {
    this.watchedCertPath = certPath;
    watchFile(certPath, { interval: 60_000 }, () => {
      try {
        const cert = readFileSync(certPath, 'utf8');
        const key = readFileSync(keyPath, 'utf8');
        this.httpsServer.setSecureContext({ cert, key });
        this.tls = { ...this.tls, cert, key };
        this.log.info('TLS certificate reloaded (renewed)');
      } catch (err) {
        this.log.warn('cert reload failed', { err: (err as Error).message });
      }
    });
  }

  /** Device ids with a currently-open WebSocket connection. */
  connectedDeviceIds(): string[] {
    return this.registry ? this.registry.list().map((c) => c.deskletId) : [];
  }

  /** Close a specific desklet's connection (used by Forget / Switch-role). */
  disconnect(deviceId: string): void {
    const conn = this.registry?.get(deviceId);
    if (!conn) return;
    try {
      conn.socket.close(1000, 'admin');
    } catch {
      /* already closing */
    }
    this.registry.remove(deviceId);
  }

  override health(): SubsystemHealth {
    return {
      status: this.degraded ? 'degraded' : 'nominal',
      detail: { connections: this.registry?.size() ?? 0, locked: this.locked },
    };
  }

  private wireBus(): void {
    this.offs.push(
      this.bus.on('context:projection', (p: RoleProjection) => {
        if (this.locked) return; // no context streamed while locked
        this.mux.deliverProjection(p);
      }),
      this.bus.on('lock:engaged', () => this.onLock()),
      this.bus.on('lock:released', () => {
        this.locked = false;
        this.log.info('transport unlocked — accepting connections');
      }),
      this.bus.on('mode:changed', (m) => {
        this.degraded = m.to === 'Degraded';
      }),
      // Reflect intent outcomes back to the originating desklet.
      this.bus.on('intent:outcome', (o) => {
        this.mux.send(o.deskletId, {
          kind: 'ack',
          correlationId: o.correlationId,
          payload: { status: o.status, detail: o.detail },
          timestamp: new Date().toISOString(),
        });
      }),
    );
  }

  private onLock(): void {
    this.locked = true;
    // Close all active connections within 1 s (immediate). (SUB-XPT-044)
    this.terminal.closeAll();
    this.gateway.closeAll();
    this.log.warn('transport locked — connections closed, upgrades rejected');
  }

  private listen(server: HttpsServer | HttpServer, port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  }
}

function closeServer(server: HttpsServer | HttpServer | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}
