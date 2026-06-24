/**
 * Heartbeat Monitor (PAIR).
 *
 * Tracks per-desklet liveness. A probe is expected each second; if no
 * acknowledgement (transport pong → ledger touch) arrives within 5 s (five
 * consecutive missed probes) the link is declared lost and DeskletLinkLost is
 * emitted. Last-seen is refreshed on each successful ack. (SUB-PAIR-038,
 * SYS-REQ-008)
 *
 * This monitors liveness via the Device Identity Ledger's last-seen timestamps,
 * which the transport's WebSocket pong handler refreshes — avoiding a second,
 * redundant ping channel while still meeting the 5 s detection budget.
 */
import type { EventBus } from '../core/bus.js';
import type { Logger } from '../core/logger.js';
import { TIMING } from '../core/constants.js';
import type { DeviceIdentityLedger } from './device-identity-ledger.js';

export class PairingHeartbeatMonitor {
  private timer: NodeJS.Timeout | undefined;
  private readonly lost = new Set<string>();

  constructor(
    private readonly ledger: DeviceIdentityLedger,
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.scan(), TIMING.PAIR_PROBE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private scan(): void {
    const now = this.now();
    for (const rec of this.ledger.list()) {
      const age = now - Date.parse(rec.lastSeen);
      const isLost = age > TIMING.PAIR_ACK_TIMEOUT_MS;
      if (isLost && !this.lost.has(rec.deviceId)) {
        this.lost.add(rec.deviceId);
        this.bus.emit('desklet:linklost', { deskletId: rec.deviceId });
        this.log.warn('desklet link lost', { deviceId: rec.deviceId, ageMs: age });
      } else if (!isLost && this.lost.delete(rec.deviceId)) {
        this.bus.emit('desklet:reconnected', { deskletId: rec.deviceId });
        this.log.info('desklet reconnected', { deviceId: rec.deviceId });
      }
    }
  }
}
