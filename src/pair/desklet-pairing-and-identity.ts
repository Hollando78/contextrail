/**
 * Desklet Pairing and Identity (PAIR) subsystem.
 *
 * Pairs, identifies, and role-binds zero-state desklets. Composes the Pairing
 * Token Generator, Device Identity Ledger, Role Assignment Manager, and
 * Heartbeat Monitor, and drives the QR/URL pairing handshake. (FN-FN-001/003/004)
 */
import { BaseSubsystem, type RuntimeContext, type SubsystemHealth } from '../core/subsystem.js';
import { SERVICE } from '../core/services.js';
import { TIMING, type Role } from '../core/constants.js';
import { fingerprint as fingerprintOf } from '../core/crypto.js';
import { sha256Hex } from '../core/crypto.js';
import { ContextRailError } from '../core/errors.js';
import { dataPaths } from '../core/paths.js';
import { PairingTokenGenerator } from './pairing-token-generator.js';
import { DeviceIdentityLedger } from './device-identity-ledger.js';
import { RoleAssignmentManager } from './role-assignment-manager.js';
import { PairingHeartbeatMonitor } from './heartbeat-monitor.js';
import type { PairingTokenAuthority } from '../slm/pairing-token-authority.js';

export interface PairingResult {
  sessionToken: string;
  expiresAt: number;
  role: Role;
  deviceId: string;
}

export class DeskletPairingAndIdentity extends BaseSubsystem {
  readonly name = 'DeskletPairingAndIdentity';

  private readonly generator: PairingTokenGenerator;
  readonly ledger: DeviceIdentityLedger;
  readonly roles: RoleAssignmentManager;
  private heartbeat!: PairingHeartbeatMonitor;
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(ctx: RuntimeContext) {
    super(ctx);
    this.init();
    this.generator = new PairingTokenGenerator(this.log.child('ott'));
    this.ledger = new DeviceIdentityLedger(dataPaths(this.config.dataDir).ledger, this.log.child('ledger'));
    this.roles = new RoleAssignmentManager(this.log.child('roles'));
  }

  override async start(): Promise<void> {
    await this.ledger.load();
    this.heartbeat = new PairingHeartbeatMonitor(this.ledger, this.bus, this.log.child('hbm'));
    this.heartbeat.start();
    this.flushTimer = setInterval(() => void this.ledger.flush(), TIMING.HAS_WARN_INTERVAL_MS);
    this.flushTimer.unref?.();

    this.services.set(SERVICE.Pairing, this);
    this.services.set(SERVICE.DeviceLedger, this.ledger);
    this.services.set(SERVICE.RoleAssignment, this.roles);
    this.log.info('pairing and identity ready', { paired: this.ledger.count() });
  }

  override async stop(): Promise<void> {
    this.heartbeat?.stop();
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.ledger.flush();
  }

  override health(): SubsystemHealth {
    return { status: 'nominal', detail: { paired: this.ledger.count() } };
  }

  // --- Pairing handshake -------------------------------------------------------

  /** Issue a one-time pairing token (OTT) for an intended role. (FN-FN-001) */
  newPairing(role: Role): { ott: string; expiresAt: number } {
    return this.generator.issue(role);
  }

  /**
   * Complete a pairing: consume the OTT, bind the role (taken from the OTT — the
   * operator chose it at the host), register the device, and issue a signed
   * session token. Must resolve well within 2 s. (IFC-PAIR-027/028, SUB-PAIR-035..037)
   */
  async completePairing(ott: string, fingerprint: string): Promise<PairingResult> {
    const role = this.generator.consume(ott);
    if (!role) {
      throw new ContextRailError('TOKEN_UNRECOGNISED', 'pairing token invalid or expired', {});
    }
    const deviceId = `dev-${sha256Hex(fingerprint).slice(0, 16)}`;
    this.roles.assign(deviceId, role);
    await this.ledger.register(deviceId, fingerprint, role);

    const pta = this.services.get<PairingTokenAuthority>(SERVICE.PairingTokenAuthority);
    const { token, expiresAt } = pta.issueSessionToken(fingerprint, role);

    this.bus.emit('desklet:paired', { deskletId: deviceId, role });
    this.log.info('desklet paired', { deviceId, role });
    return { sessionToken: token, expiresAt, role, deviceId };
  }

  /** Stable device id for a client fingerprint (used on reconnect). */
  deviceIdFor(fingerprint: string): string {
    return `dev-${sha256Hex(fingerprint).slice(0, 16)}`;
  }

  /** Build a fingerprint from client-supplied stable attributes. */
  fingerprint(parts: Record<string, string>): string {
    return fingerprintOf(parts);
  }
}
