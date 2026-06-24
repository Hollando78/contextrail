/**
 * Process Supervisor (EXE).
 *
 * The single point of timeout enforcement and output capture for local
 * execution. Acknowledges execution-started within 200 ms, enforces a 5 s
 * wall-clock timeout and on expiry sends SIGKILL to the whole process group,
 * captures the first 4 KB of combined stdout/stderr, computes its SHA-256 digest,
 * and reports a truncation flag. (SUB-EXE-022, SUB-EXE-023, ARC-REQ-011)
 */
import { spawn } from 'node:child_process';
import type { Logger } from '../core/logger.js';
import { SIZES, TIMING } from '../core/constants.js';
import { sha256Hex } from '../core/crypto.js';
import type { CommandEnvelope } from '../core/types.js';

export interface ProcessResult {
  intentId: string;
  status: 'SUCCESS' | 'FAILURE' | 'TIMEOUT';
  exitCode: number;
  stdoutDigest: string;
  truncated: boolean;
  elapsedMs: number;
}

export class ProcessSupervisor {
  constructor(
    private readonly log: Logger,
    private readonly onStarted?: (intentId: string) => void,
  ) {}

  run(cmd: CommandEnvelope): Promise<ProcessResult> {
    if (cmd.detached) return this.runDetached(cmd);
    return new Promise<ProcessResult>((resolve) => {
      const start = Date.now();
      let captured = Buffer.alloc(0);
      let truncated = false;
      let settled = false;

      const child = spawn(cmd.targetPath, cmd.args, {
        env: { ...process.env, ...cmd.env },
        // New process group so a timeout SIGKILL takes the whole tree.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });

      // Execution-started acknowledgement within 200 ms (immediate). (SUB-EXE-022)
      const ackTimer = setTimeout(() => this.onStarted?.(cmd.intentId), 0);
      void TIMING.EXEC_STARTED_ACK_MS;

      const capture = (chunk: Buffer) => {
        if (captured.length >= SIZES.LOCAL_OUTPUT_CAP_BYTES) {
          truncated = true;
          return;
        }
        const room = SIZES.LOCAL_OUTPUT_CAP_BYTES - captured.length;
        if (chunk.length > room) {
          captured = Buffer.concat([captured, chunk.subarray(0, room)]);
          truncated = true;
        } else {
          captured = Buffer.concat([captured, chunk]);
        }
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);

      const finish = (status: ProcessResult['status'], exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(ackTimer);
        clearTimeout(killTimer);
        resolve({
          intentId: cmd.intentId,
          status,
          exitCode,
          stdoutDigest: sha256Hex(captured),
          truncated,
          elapsedMs: Date.now() - start,
        });
      };

      // 5 s wall-clock timeout -> SIGKILL the process group. (SUB-EXE-022)
      const killTimer = setTimeout(() => {
        this.log.warn('local exec timeout — SIGKILL', { intentId: cmd.intentId });
        this.kill(child);
        finish('TIMEOUT', -1);
      }, TIMING.LOCAL_EXEC_TIMEOUT_MS);

      child.on('error', (err) => {
        this.log.warn('spawn error', { intentId: cmd.intentId, err: err.message });
        finish('FAILURE', -1);
      });
      child.on('close', (code) => finish(code === 0 ? 'SUCCESS' : 'FAILURE', code ?? -1));
    });
  }

  /**
   * Fire-and-forget launch: resolve SUCCESS as soon as the process spawns, detach
   * + unref so the launched app/browser outlives the host, and apply no kill timer.
   * (Used for launch-tool / open-url; the OS launcher returns slowly on Windows.)
   */
  private runDetached(cmd: CommandEnvelope): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve) => {
      const start = Date.now();
      const done = (status: ProcessResult['status'], exitCode: number) =>
        resolve({ intentId: cmd.intentId, status, exitCode, stdoutDigest: '', truncated: false, elapsedMs: Date.now() - start });
      try {
        const child = spawn(cmd.targetPath, cmd.args, {
          env: { ...process.env, ...cmd.env },
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        this.onStarted?.(cmd.intentId);
        child.on('error', (err) => {
          this.log.warn('detached spawn error', { intentId: cmd.intentId, err: err.message });
          done('FAILURE', -1);
        });
        child.on('spawn', () => {
          child.unref();
          done('SUCCESS', 0);
        });
      } catch (err) {
        this.log.warn('detached spawn threw', { intentId: cmd.intentId, err: (err as Error).message });
        done('FAILURE', -1);
      }
    });
  }

  private kill(child: ReturnType<typeof spawn>): void {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      } else if (child.pid) {
        process.kill(-child.pid, 'SIGKILL'); // negative pid => process group
      }
    } catch {
      child.kill('SIGKILL');
    }
  }
}
