/**
 * Deep Integration Boundary (DIB).
 *
 * Accepts DEEP adapter connections over a Unix domain socket (named pipe on
 * Windows) speaking newline-delimited JSON-RPC. Completes a capability-grant
 * handshake within 500 ms, routes workspace context events to subscribed
 * adapters within 50 ms (rate-limited to 100 events/s each), denies + logs any
 * action exceeding the adapter's registered capability scope, and terminates a
 * session whose heartbeat is not seen within 10 s, releasing its subscriptions.
 * (SUB-DIB-056..059, ARC-REQ-017)
 */
import { createServer, type Server, type Socket } from 'node:net';
import { unlink } from 'node:fs/promises';
import type { EventBus } from '../core/bus.js';
import type { Logger } from '../core/logger.js';
import { LIMITS, TIMING } from '../core/constants.js';
import { CapabilityScopeEnforcer } from './capability-scope-enforcer.js';
import type { PolicyEngine } from '../acg/policy-engine.js';

interface Session {
  socket: Socket;
  id?: string;
  capabilities: string[];
  subscribed: boolean;
  heartbeatTimer?: NodeJS.Timeout;
  tokens: number;
  buf: string;
}

export class DeepIntegrationBoundary {
  private server: Server | undefined;
  private readonly sessions = new Set<Session>();
  private readonly scope = new CapabilityScopeEnforcer();
  private refillTimer: NodeJS.Timeout | undefined;
  private offBus: (() => void) | undefined;

  constructor(
    private readonly socketPath: string,
    private readonly bus: EventBus,
    private readonly policy: PolicyEngine,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    if (process.platform !== 'win32') {
      await unlink(this.socketPath).catch(() => undefined); // clear stale socket
    }
    this.server = createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });

    // Per-second token refill for the 100 events/s/adapter rate limit.
    this.refillTimer = setInterval(() => {
      for (const s of this.sessions) s.tokens = LIMITS.DEEP_EVENTS_PER_SEC;
    }, 1000);
    this.refillTimer.unref?.();

    // Forward context updates to subscribed DEEP adapters within 50 ms (immediate).
    this.offBus = this.bus.on('context:updated', (u) => this.fanout(u));
    this.log.info('deep integration boundary listening', { socket: this.socketPath });
  }

  async stop(): Promise<void> {
    this.offBus?.();
    if (this.refillTimer) clearInterval(this.refillTimer);
    for (const s of this.sessions) s.socket.destroy();
    this.sessions.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  private onConnection(socket: Socket): void {
    const session: Session = { socket, capabilities: [], subscribed: false, tokens: LIMITS.DEEP_EVENTS_PER_SEC, buf: '' };
    this.sessions.add(session);
    // Handshake must complete within 500 ms or the connection is dropped.
    const handshakeTimer = setTimeout(() => {
      if (!session.id) {
        this.log.warn('deep adapter handshake timeout');
        socket.destroy();
      }
    }, TIMING.ROLE_RENDER_MS);
    handshakeTimer.unref?.();

    socket.on('data', (chunk) => {
      session.buf += chunk.toString();
      let nl: number;
      while ((nl = session.buf.indexOf('\n')) >= 0) {
        const line = session.buf.slice(0, nl);
        session.buf = session.buf.slice(nl + 1);
        if (line.trim()) this.onMessage(session, line, handshakeTimer);
      }
    });
    socket.on('close', () => this.endSession(session));
    socket.on('error', () => this.endSession(session));
  }

  private onMessage(session: Session, line: string, handshakeTimer: NodeJS.Timeout): void {
    let msg: { method?: string; params?: Record<string, unknown>; id?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return this.send(session, { error: 'invalid JSON' });
    }
    switch (msg.method) {
      case 'register': {
        clearTimeout(handshakeTimer);
        session.id = String(msg.params?.['id'] ?? '');
        session.capabilities = Array.isArray(msg.params?.['capabilities'])
          ? (msg.params!['capabilities'] as string[])
          : [];
        this.armHeartbeat(session);
        this.send(session, { id: msg.id, result: 'granted', capabilities: session.capabilities });
        this.log.info('deep adapter registered', { id: session.id, capabilities: session.capabilities });
        break;
      }
      case 'heartbeat':
        this.armHeartbeat(session);
        this.send(session, { id: msg.id, result: 'ok' });
        break;
      case 'subscribe':
        session.subscribed = true;
        this.send(session, { id: msg.id, result: 'subscribed' });
        break;
      case 'action': {
        const action = String(msg.params?.['action'] ?? '');
        if (!this.scope.permits(session.capabilities, action)) {
          this.log.error('deep action exceeds capability scope (denied)', { id: session.id, action });
          this.send(session, { id: msg.id, error: 'CAPABILITY_EXCEEDED' });
          break;
        }
        // Orthogonal allowlist gate still applies to every host-mediated action.
        const decision = this.policy.evaluate({ principal: session.id ?? 'deep', action });
        this.send(session, { id: msg.id, result: decision.decision, ...(decision.reason ? { reason: decision.reason } : {}) });
        break;
      }
      default:
        this.send(session, { id: msg.id, error: 'unknown method' });
    }
  }

  private fanout(update: unknown): void {
    for (const s of this.sessions) {
      if (!s.subscribed || !s.id) continue;
      if (s.tokens <= 0) continue; // rate limit: drop beyond 100/s
      s.tokens -= 1;
      this.send(s, { method: 'context', params: update });
    }
  }

  private armHeartbeat(session: Session): void {
    if (session.heartbeatTimer) clearTimeout(session.heartbeatTimer);
    session.heartbeatTimer = setTimeout(() => {
      this.log.warn('deep adapter heartbeat timeout — terminating session', { id: session.id });
      session.socket.destroy();
    }, TIMING.DEEP_HEARTBEAT_TIMEOUT_MS);
    session.heartbeatTimer.unref?.();
  }

  private endSession(session: Session): void {
    if (session.heartbeatTimer) clearTimeout(session.heartbeatTimer);
    this.sessions.delete(session);
  }

  private send(session: Session, obj: unknown): void {
    if (!session.socket.destroyed) session.socket.write(JSON.stringify(obj) + '\n');
  }
}
