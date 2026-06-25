/**
 * Terminal Session Manager (XPT).
 *
 * Runs an interactive `claude` process in a pseudo-terminal (ConPTY on Windows)
 * inside the guardrailed `ai-console/` workspace, and bridges its I/O to an AI
 * desklet's embedded terminal over the WebSocket `term` channel. One session per
 * desklet; killed on close/disconnect/lock. The PTY runs `claude` directly (not a
 * persistent shell), so when claude exits the session ends — there is no shell to
 * fall back into. The process inherits the host environment, so it uses the
 * operator's existing Claude subscription auth. (Action authoring on a desklet.)
 */
import * as pty from '@lydell/node-pty';
import { join } from 'node:path';
import type { Logger } from '../core/logger.js';
import type { WsFrame } from '../core/types.js';

type Send = (deskletId: string, frame: WsFrame) => void;

const termFrame = (payload: unknown): WsFrame => ({ kind: 'term', payload, timestamp: new Date().toISOString() });

export class TerminalSessionManager {
  private readonly sessions = new Map<string, pty.IPty>();

  constructor(
    private readonly send: Send,
    private readonly log: Logger,
  ) {}

  /** Open (or restart) the claude PTY for a desklet. */
  open(deskletId: string, cols = 80, rows = 24): void {
    this.close(deskletId); // one session per desklet
    const cwd = join(process.cwd(), 'ai-console');
    const file = process.platform === 'win32' ? 'cmd.exe' : process.env['SHELL'] || 'bash';
    const args = process.platform === 'win32' ? ['/c', 'claude'] : ['-lc', 'claude'];
    let p: pty.IPty;
    try {
      p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: process.env as Record<string, string> });
    } catch (err) {
      this.send(deskletId, termFrame({ op: 'exit', code: -1, error: (err as Error).message }));
      this.log.warn('terminal spawn failed', { deskletId, err: (err as Error).message });
      return;
    }
    this.sessions.set(deskletId, p);
    this.log.info('terminal session opened', { deskletId });
    p.onData((data) => this.send(deskletId, termFrame({ op: 'data', data })));
    p.onExit(({ exitCode }) => {
      this.sessions.delete(deskletId);
      this.send(deskletId, termFrame({ op: 'exit', code: exitCode }));
      this.log.info('terminal session exited', { deskletId, exitCode });
    });
  }

  input(deskletId: string, data: string): void {
    this.sessions.get(deskletId)?.write(data);
  }

  resize(deskletId: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    try {
      this.sessions.get(deskletId)?.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      /* session may have exited */
    }
  }

  close(deskletId: string): void {
    const p = this.sessions.get(deskletId);
    if (!p) return;
    this.sessions.delete(deskletId);
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
