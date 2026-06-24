/**
 * Device Identity Ledger (PAIR).
 *
 * The single source of trust for paired desklets. Persists pairing records
 * (device identifier, fingerprint, assigned role, pairing timestamp, last-seen)
 * across host restarts via an append-only JSONL log. Caps concurrent registered
 * desklets at 8 and serves a read-stable query path that does not block on
 * concurrent writes. (SUB-PAIR-036, IFC-PAIR-036/037, ARC-REQ-013)
 */
import { appendFile, readFile, writeFile, rename } from 'node:fs/promises';
import type { Logger } from '../core/logger.js';
import type { Role } from '../core/constants.js';
import { LIMITS } from '../core/constants.js';
import type { PairingRecord } from '../core/types.js';
import { ContextRailError } from '../core/errors.js';

export class DeviceIdentityLedger {
  private readonly records = new Map<string, PairingRecord>();
  private dirty = false;

  constructor(
    private readonly path: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Load persisted records (last write wins per device). */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as PairingRecord & { _deleted?: boolean };
          if (rec._deleted) this.records.delete(rec.deviceId);
          else this.records.set(rec.deviceId, rec);
        } catch {
          /* skip malformed line */
        }
      }
      this.log.info('device ledger loaded', { devices: this.records.size });
    } catch {
      this.log.info('no device ledger found (fresh start)');
    }
  }

  /**
   * Register a new pairing atomically. Throws DEVICE_LIMIT_EXCEEDED when 8 are
   * already registered (unless re-registering an existing device). (SUB-PAIR-036)
   */
  async register(deviceId: string, fingerprint: string, role: Role): Promise<PairingRecord> {
    if (!this.records.has(deviceId) && this.records.size >= LIMITS.MAX_DESKLETS) {
      throw new ContextRailError('DEVICE_LIMIT_EXCEEDED', 'maximum paired desklets reached', {
        limit: LIMITS.MAX_DESKLETS,
      });
    }
    const ts = new Date(this.now()).toISOString();
    const record: PairingRecord = { deviceId, fingerprint, role, pairedAt: ts, lastSeen: ts };
    this.records.set(deviceId, record);
    await appendFile(this.path, JSON.stringify(record) + '\n', 'utf8'); // atomic single-line append
    return record;
  }

  /** Reassign a device's bound role and persist (operator switch-role). */
  async setRole(deviceId: string, role: Role): Promise<boolean> {
    const rec = this.records.get(deviceId);
    if (!rec) return false;
    rec.role = role;
    await appendFile(this.path, JSON.stringify(rec) + '\n', 'utf8');
    return true;
  }

  /** Update last-seen (called on heartbeat pong / activity). Read-stable. */
  touch(deviceId: string): void {
    const rec = this.records.get(deviceId);
    if (rec) {
      rec.lastSeen = new Date(this.now()).toISOString();
      this.dirty = true;
    }
  }

  get(deviceId: string): PairingRecord | undefined {
    return this.records.get(deviceId);
  }

  /** Read-only snapshot that never blocks on writes. (IFC-PAIR-037) */
  list(): PairingRecord[] {
    return [...this.records.values()];
  }

  count(): number {
    return this.records.size;
  }

  async remove(deviceId: string): Promise<void> {
    if (this.records.delete(deviceId)) {
      await appendFile(this.path, JSON.stringify({ deviceId, _deleted: true }) + '\n', 'utf8');
    }
  }

  /** Compact + flush last-seen updates by rewriting the log atomically. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    const tmp = `${this.path}.tmp`;
    const body = this.list().map((r) => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, this.path);
    this.dirty = false;
  }
}
