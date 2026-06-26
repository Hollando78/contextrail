/**
 * Remote Control (HAS).
 *
 * Backs the Remote desklet role: enumerate the host's top-level windows, bring
 * one to the foreground, and relay input to it (text, special keys) — so an
 * operator can, from a paired phone, cycle the open windows and nudge a waiting
 * process (the headline case: typing "continue" into a Claude Code terminal).
 *
 * Host-side and operator-only. It injects real keystrokes, so it is the most
 * powerful capability in the host; it is role-gated to Remote desklets and can
 * be disabled with CONTEXTRAIL_REMOTE_CONTROL=0. Windows uses Win32 +
 * System.Windows.Forms.SendKeys via PowerShell; other platforms are best-effort.
 */
import { spawn } from 'node:child_process';
import type { Logger } from '../core/logger.js';

export interface HostWindow {
  /** Process id of the owning process (stable handle for focus). */
  id: string;
  title: string;
  app: string;
}

/** Friendly key names accepted from the desklet, mapped to SendKeys tokens. */
const KEY_TOKENS: Record<string, string> = {
  enter: '{ENTER}',
  esc: '{ESC}',
  escape: '{ESC}',
  tab: '{TAB}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  backspace: '{BACKSPACE}',
  space: ' ',
  'ctrl-c': '^c',
  'ctrl-v': '^v',
  'ctrl-s': '^s',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
};

/** Escape literal text for SendKeys (its metacharacters are {}()+^%~[]). */
function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (m) => `{${m}}`);
}

export class RemoteControl {
  constructor(private readonly log: Logger) {}

  enabled(): boolean {
    return process.platform === 'win32' && process.env['CONTEXTRAIL_REMOTE_CONTROL'] !== '0';
  }

  /** Top-level windows with a visible title (most recent first is not guaranteed). */
  async listWindows(): Promise<HostWindow[]> {
    if (!this.enabled()) return [];
    const ps =
      "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | " +
      'Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress';
    try {
      const out = await this.run(['-NoProfile', '-NonInteractive', '-Command', ps]);
      const parsed = JSON.parse(out.trim() || '[]');
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .filter((r) => r && r.MainWindowTitle)
        .map((r) => ({ id: String(r.Id), title: String(r.MainWindowTitle), app: String(r.ProcessName) }));
    } catch (err) {
      this.log.warn('listWindows failed', { err: (err as Error).message });
      return [];
    }
  }

  /** Bring a window to the foreground by owning process id. */
  async focus(windowId: string): Promise<boolean> {
    if (!this.enabled()) return false;
    const pid = this.pid(windowId);
    if (pid == null) return false;
    return this.run(['-NoProfile', '-NonInteractive', '-Command', this.focusScript(pid)])
      .then(() => true)
      .catch((err) => {
        this.log.warn('focus failed', { windowId, err: (err as Error).message });
        return false;
      });
  }

  /** Focus a window, then type text (optionally followed by Enter). */
  async type(windowId: string, text: string, enter: boolean): Promise<boolean> {
    if (!this.enabled()) return false;
    const pid = this.pid(windowId);
    if (pid == null) return false;
    const keys = escapeSendKeys(text) + (enter ? '{ENTER}' : '');
    return this.sendTo(pid, keys, { windowId });
  }

  /** Focus a window, then send a single special key / chord. */
  async key(windowId: string, name: string): Promise<boolean> {
    if (!this.enabled()) return false;
    const pid = this.pid(windowId);
    if (pid == null) return false;
    const token = KEY_TOKENS[name.toLowerCase()];
    if (!token) {
      this.log.warn('unknown remote key', { name });
      return false;
    }
    return this.sendTo(pid, token, { windowId });
  }

  // --- internals --------------------------------------------------------------

  private pid(windowId: string): number | null {
    const n = Number(windowId);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  private async sendTo(pid: number, sendKeys: string, ctx: { windowId: string }): Promise<boolean> {
    const script =
      this.focusScript(pid) +
      '; Start-Sleep -Milliseconds 250; ' +
      'Add-Type -AssemblyName System.Windows.Forms; ' +
      '[System.Windows.Forms.SendKeys]::SendWait($env:CR_REMOTE_KEYS)';
    try {
      await this.run(['-NoProfile', '-NonInteractive', '-Command', script], { CR_REMOTE_KEYS: sendKeys });
      return true;
    } catch (err) {
      this.log.warn('send failed', { ...ctx, err: (err as Error).message });
      return false;
    }
  }

  private focusScript(pid: number): string {
    return (
      `$h = (Get-Process -Id ${pid} -ErrorAction Stop).MainWindowHandle; ` +
      'Add-Type @"\nusing System;\nusing System.Runtime.InteropServices;\npublic class CRWin {\n' +
      '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);\n' +
      '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);\n}\n"@; ' +
      '[CRWin]::ShowWindow($h, 9) | Out-Null; [CRWin]::SetForegroundWindow($h) | Out-Null'
    );
  }

  private run(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell', args, { env: { ...process.env, ...extraEnv }, windowsHide: true });
      let out = '';
      let err = '';
      child.stdout?.on('data', (c) => (out += c));
      child.stderr?.on('data', (c) => (err += c));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `exit ${code}`))));
    });
  }
}
