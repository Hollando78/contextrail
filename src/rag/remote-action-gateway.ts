/**
 * Remote Action Gateway (RAG) subsystem.
 *
 * A thin in-process broker for host-mediated SSH actions: it validates each
 * request against the allowlist (via the Remote SSH Boundary's gate), dispatches
 * through a fresh SSH session (no pool), and emits a JSON result envelope. On
 * LOCK it terminates in-progress sessions within 1 s and rejects new requests
 * with a LOCKED envelope. Exposes the executor's 'rag' route. (FN-FN-016,
 * ARC-REQ-015, SUB-RAG-046..050)
 */
import { BaseSubsystem, type RuntimeContext, type SubsystemHealth } from '../core/subsystem.js';
import { SERVICE } from '../core/services.js';
import { dataPaths } from '../core/paths.js';
import type { CommandEnvelope, CommandResult, SshActionRequest, SshResultEnvelope } from '../core/types.js';
import type { CommandExecutor } from '../exe/command-dispatcher.js';
import type { PolicyEngine } from '../acg/policy-engine.js';
import { SshRateLimiter } from '../rsb/ssh-rate-limiter.js';
import { SshConfigResolver } from '../rsb/ssh-config-resolver.js';
import { SshAuditLogger } from '../rsb/ssh-audit-logger.js';
import { RemoteSshBoundary } from '../rsb/remote-ssh-boundary.js';

export class RemoteActionGateway extends BaseSubsystem implements CommandExecutor {
  readonly name = 'RemoteActionGateway';

  private boundary!: RemoteSshBoundary;
  private audit!: SshAuditLogger;
  private locked = false;
  private off: (() => void) | undefined;
  private offUnlock: (() => void) | undefined;

  constructor(ctx: RuntimeContext) {
    super(ctx);
    this.init();
  }

  override async start(): Promise<void> {
    const policy = this.services.get<PolicyEngine>(SERVICE.PolicyEngine);
    const paths = dataPaths(this.config.dataDir);
    this.audit = new SshAuditLogger(paths.sshAudit, this.log.child('audit'));
    await this.audit.prune();

    this.boundary = new RemoteSshBoundary(
      new SshRateLimiter(),
      new SshConfigResolver(this.config.ssh.configPath, this.log.child('resolver')),
      this.audit,
      policy,
      this.log.child('rsb'),
    );

    // On LOCK, terminate sessions within 1 s and reject new requests. (SUB-RAG-050)
    this.off = this.bus.on('lock:engaged', () => {
      this.locked = true;
      this.boundary.terminateAll();
    });
    this.offUnlock = this.bus.on('lock:released', () => {
      this.locked = false;
    });

    this.services.set(SERVICE.RemoteGateway, this);
    this.log.info('remote action gateway ready', { live: process.env['CONTEXTRAIL_SSH_LIVE'] === '1' });
  }

  override async stop(): Promise<void> {
    this.off?.();
    this.offUnlock?.();
    this.boundary?.terminateAll();
  }

  override health(): SubsystemHealth {
    return { status: 'nominal', detail: { locked: this.locked } };
  }

  /** Executor 'rag' route: map a CommandEnvelope to an SSH action + result. */
  async execute(cmd: CommandEnvelope): Promise<CommandResult> {
    if (this.locked) {
      const env = this.lockedEnvelope(cmd);
      this.bus.emit('intent:outcome', {
        intentId: cmd.intentId,
        correlationId: cmd.intentId,
        deskletId: '',
        status: 'DENIED',
        detail: env,
      });
      return this.toResult(cmd, env);
    }

    const req: SshActionRequest = {
      commandText: cmd.actionId,
      targetHostAlias: cmd.env['TARGET_HOST'] ?? '',
      adapterIdentity: 'rag',
      commandClass: cmd.env['COMMAND_CLASS'] === 'streaming' ? 'streaming' : 'bounded',
      sshSessionId: cmd.env['SSH_SESSION_ID'] ?? cmd.intentId,
    };
    const envelope = await this.boundary.execute(req);
    return this.toResult(cmd, envelope);
  }

  private toResult(cmd: CommandEnvelope, env: SshResultEnvelope): CommandResult {
    const status: CommandResult['status'] =
      env.status === 'permit' ? (env.exitCode === 0 ? 'SUCCESS' : 'FAILURE')
      : env.status === 'timeout' ? 'TIMEOUT'
      : 'DENIED';
    return {
      intentId: cmd.intentId,
      status,
      exitCode: env.exitCode,
      stdoutDigest: '',
      truncated: false,
      elapsedMs: env.durationMs,
      ...(env.reason ? { reason: env.reason } : {}),
    };
  }

  private lockedEnvelope(cmd: CommandEnvelope): SshResultEnvelope {
    return {
      status: 'locked',
      targetHost: cmd.env['TARGET_HOST'] ?? '',
      command: cmd.actionId,
      stdout: '',
      stderr: '',
      exitCode: -1,
      durationMs: 0,
      timestamp: new Date().toISOString(),
      reason: 'LOCKED',
    };
  }
}
