/**
 * Service registry.
 *
 * The architecture decisions mandate in-process, synchronous calls between
 * subsystems on the hot paths (ARC-REQ-008/009/012/014/016). Subsystems publish
 * a narrow service interface here as they start; later subsystems resolve their
 * dependencies by key. Because boot is strictly ordered and sequential, a
 * subsystem's `start()` can safely resolve any dependency that boots before it.
 */
export const SERVICE = {
  PairingTokenAuthority: 'slm.pta',
  LockState: 'slm.lock',
  ContextAccessGuard: 'slm.guard',
  HostAuthenticator: 'slm.auth',
  PolicyEngine: 'acg.policy',
  AllowlistStore: 'acg.store',
  MaintenanceConfig: 'acg.maint',
  ContextStore: 'ctx.store',
  Pairing: 'pair.subsystem',
  DeviceLedger: 'pair.ledger',
  RoleAssignment: 'pair.roles',
  Transport: 'xpt.server',
  Executor: 'exe.executor',
  RemoteGateway: 'rag.gateway',
  AdapterFramework: 'adp.framework',
  IntentRouter: 'int.router',
  ModeControl: 'hcr.mode',
  AdminApi: 'has.admin',
} as const;

/** Mode-control surface the Admin Station uses to drive Maintenance. */
export interface ModeControl {
  mode(): string;
  enterMaintenance(): boolean;
  leaveMaintenance(): boolean;
}

/** A loopback admin request handler registered by the Host Admin Station. */
export interface AdminApi {
  handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void>;
}

export type ServiceKey = (typeof SERVICE)[keyof typeof SERVICE];

export class ServiceRegistry {
  private readonly map = new Map<string, unknown>();

  set<T>(key: ServiceKey, value: T): void {
    this.map.set(key, value);
  }

  get<T>(key: ServiceKey): T {
    const v = this.map.get(key);
    if (v === undefined) throw new Error(`service not available: ${key}`);
    return v as T;
  }

  tryGet<T>(key: ServiceKey): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  has(key: ServiceKey): boolean {
    return this.map.has(key);
  }
}
