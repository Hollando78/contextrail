/**
 * Remote SSH Boundary (RSB).
 *
 * Runs the SSH path in the mandated order: rate-check → allowlist-check →
 * credential-resolve → spawn → audit. Bounded commands are killed at 30 s and
 * yield a TIMEOUT envelope (exit_code -1); streaming commands (deploy, backup)
 * have no fixed ceiling. SSH credentials are read only after the rate and
 * allowlist gates pass, and never come from a desklet. (ARC-REQ-018, SUB-RSB-060..063,
 * SUB-RAG-048, IFC-RSB-052)
 *
 * Real outbound SSH is gated behind CONTEXTRAIL_SSH_LIVE=1; otherwise the
 * boundary runs in dry-run mode (all gates enforced, audit written, but no
 * connection is made) so nothing dials out by accident.
 */
import { Client } from 'ssh2';
import { readFileSync } from 'node:fs';
import type { Logger } from '../core/logger.js';
import { LIMITS, SIZES, SSH_STREAMING_CLASSES, TIMING, type SshCommandClass } from '../core/constants.js';
import type { SshActionRequest, SshResultEnvelope } from '../core/types.js';
import type { PolicyEngine } from '../acg/policy-engine.js';
import { SshRateLimiter } from './ssh-rate-limiter.js';
import { SshConfigResolver } from './ssh-config-resolver.js';
import { SshAuditLogger } from './ssh-audit-logger.js';

export class RemoteSshBoundary {
  private readonly live = process.env['CONTEXTRAIL_SSH_LIVE'] === '1';
  /** Active connections, so a LOCK can terminate them within 1 s. (SUB-RAG-050) */
  private readonly active = new Set<Client>();

  constructor(
    private readonly rateLimiter: SshRateLimiter,
    private readonly resolver: SshConfigResolver,
    private readonly audit: SshAuditLogger,
    private readonly policy: PolicyEngine,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(req: SshActionRequest): Promise<SshResultEnvelope> {
    const start = this.now();
    const base = { targetHost: req.targetHostAlias, command: req.commandText };
    const envelope = (status: SshResultEnvelope['status'], extra: Partial<SshResultEnvelope> = {}): SshResultEnvelope => ({
      status,
      targetHost: req.targetHostAlias,
      command: req.commandText,
      stdout: '',
      stderr: '',
      exitCode: extra.exitCode ?? -1,
      durationMs: this.now() - start,
      timestamp: new Date(this.now()).toISOString(),
      ...extra,
    });

    // 1) Rate check (entry point). (SUB-RSB-063)
    if (!this.rateLimiter.tryAcquire(req.adapterIdentity)) {
      await this.audit.record({ ...this.auditBase(base, req), timestamp: new Date(this.now()).toISOString(), verdict: 'rate-limited', exitCode: -1, durationMs: this.now() - start });
      return envelope('error', { reason: 'RATE_LIMITED' });
    }

    // 2) Allowlist check (default-deny). (SUB-RSB-060, SUB-RAG-046)
    const decision = this.policy.evaluate({ principal: req.adapterIdentity, action: req.commandText });
    if (decision.decision === 'DENY') {
      await this.audit.record({ ...this.auditBase(base, req), timestamp: new Date(this.now()).toISOString(), verdict: 'deny', exitCode: 126, durationMs: this.now() - start, ...(decision.reason ? { reason: decision.reason } : {}) });
      return envelope('deny', { exitCode: 126, ...(decision.reason ? { reason: decision.reason } : {}) }); // exit 126 per IFC-RAG-025
    }

    // 3) Credential / host resolve — only now are SSH config + keys consulted.
    const host = await this.resolver.resolve(req.targetHostAlias);
    if (!host) {
      await this.audit.record({ ...this.auditBase(base, req), timestamp: new Date(this.now()).toISOString(), verdict: 'error', exitCode: -1, durationMs: this.now() - start, reason: 'host not in ssh config' });
      return envelope('error', { stderr: `host '${req.targetHostAlias}' not found in ssh config` });
    }

    // 4) Spawn (live) or simulate (dry-run).
    // Streaming if the caller declared it, or the command class is deploy/backup.
    const streaming =
      req.commandClass === 'streaming' ||
      SSH_STREAMING_CLASSES.has(guessClass(req.commandText) as SshCommandClass);
    let result: SshResultEnvelope;
    if (!this.live) {
      result = envelope('permit', { exitCode: 0, stdout: `[dry-run] would run: ${req.commandText} on ${host.hostName}` });
    } else {
      result = await this.spawn(host, req, streaming, start, envelope);
    }

    // 5) Audit (always).
    await this.audit.record({ ...this.auditBase(base, req), timestamp: result.timestamp, verdict: result.status, exitCode: result.exitCode, durationMs: result.durationMs, ...(result.reason ? { reason: result.reason } : {}) });
    return result;
  }

  /** Terminate all in-progress SSH sessions (on LOCK). (SUB-RAG-050) */
  terminateAll(): void {
    for (const conn of this.active) {
      try {
        conn.end();
      } catch {
        /* ignore */
      }
    }
    this.active.clear();
  }

  private spawn(
    host: Awaited<ReturnType<SshConfigResolver['resolve']>> & object,
    req: SshActionRequest,
    streaming: boolean,
    start: number,
    envelope: (status: SshResultEnvelope['status'], extra?: Partial<SshResultEnvelope>) => SshResultEnvelope,
  ): Promise<SshResultEnvelope> {
    return new Promise<SshResultEnvelope>((resolve) => {
      const conn = new Client();
      this.active.add(conn);
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (env: SshResultEnvelope) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(conn);
        try {
          conn.end();
        } catch {
          /* ignore */
        }
        resolve(env);
      };

      // Bounded commands time out at 30 s -> TIMEOUT envelope. (SUB-RAG-048)
      const timer = streaming
        ? undefined
        : setTimeout(() => finish(envelope('timeout', { exitCode: -1, reason: 'TIMEOUT', stdout, stderr })), TIMING.SSH_BOUNDED_TIMEOUT_MS);
      void LIMITS;

      conn
        .on('ready', () => {
          conn.exec(req.commandText, (err, stream) => {
            if (err) return finish(envelope('error', { stderr: err.message }));
            stream
              .on('close', (code: number) => finish(envelope('permit', { exitCode: code ?? 0, stdout, stderr })))
              .on('data', (d: Buffer) => {
                if (stdout.length < SIZES.SSH_STDOUT_MAX_BYTES) stdout += d.toString();
              })
              .stderr.on('data', (d: Buffer) => {
                if (stderr.length < SIZES.SSH_STDERR_MAX_BYTES) stderr += d.toString();
              });
          });
        })
        .on('error', (err) => finish(envelope('error', { stderr: err.message })))
        .connect({
          host: host.hostName,
          port: host.port,
          ...(host.user ? { username: host.user } : {}),
          ...(process.env['SSH_AUTH_SOCK'] ? { agent: process.env['SSH_AUTH_SOCK'] } : {}),
          // identity file (if any) is read here — after the gates have passed.
          ...(host.identityFile ? { privateKey: tryReadKey(host.identityFile) } : {}),
        });
    });
  }

  private auditBase(base: { targetHost: string; command: string }, req: SshActionRequest) {
    return { command: base.command, targetHost: base.targetHost, adapter: req.adapterIdentity };
  }
}

function guessClass(command: string): string {
  const c = command.toLowerCase();
  if (c.includes('deploy')) return 'deploy';
  if (c.includes('backup')) return 'backup';
  if (c.includes('restart')) return 'restart';
  if (c.includes('status')) return 'service-status';
  if (c.includes('tail') || c.includes('log')) return 'log-tail';
  return 'health-check';
}

function tryReadKey(path: string): Buffer | undefined {
  try {
    // Synchronous read is acceptable here: occurs once per (already-gated) connection.
    return readFileSync(path);
  } catch {
    return undefined;
  }
}
