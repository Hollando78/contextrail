/**
 * Heartbeat Monitor (XPT).
 *
 * Sends a WebSocket ping to each active connection every 2 s and fires a
 * disconnect if no pong arrives within 5 s of the latest ping, removing the
 * connection from the registry within 100 ms. Each pong refreshes the Device
 * Identity Ledger's last-seen so the pairing monitor sees liveness.
 * (SUB-XPT-041, IFC-XPT-040)
 */
import type { Logger } from '../core/logger.js';
import { TIMING } from '../core/constants.js';
import type { ConnectionRegistry } from './connection-registry.js';
import type { DeviceIdentityLedger } from '../pair/device-identity-ledger.js';

export class TransportHeartbeatMonitor {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly ledger: DeviceIdentityLedger | undefined,
    private readonly log: Logger,
    private readonly onDrop: (deskletId: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), TIMING.XPT_PING_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Call when a pong is received for a desklet. */
  onPong(deskletId: string): void {
    this.registry.markPong(deskletId);
    this.ledger?.touch(deskletId);
  }

  private tick(): void {
    const now = this.now();
    for (const conn of this.registry.list()) {
      const sincePong = now - conn.lastPong;
      if (sincePong > TIMING.XPT_PONG_TIMEOUT_MS) {
        this.log.warn('desklet pong timeout — dropping', { deskletId: conn.deskletId, sincePong });
        try {
          conn.socket.terminate();
        } catch {
          /* already closed */
        }
        this.registry.remove(conn.deskletId); // within 100 ms (immediate)
        this.onDrop(conn.deskletId);
        continue;
      }
      try {
        if (conn.socket.readyState === conn.socket.OPEN) conn.socket.ping();
      } catch {
        /* ignore */
      }
    }
  }
}
