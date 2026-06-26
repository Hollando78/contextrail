/**
 * Mouse Control (HAS).
 *
 * Backs the Touchpad desklet role: turns a paired phone into a trackpad for the
 * host pointer. Mouse movement must be smooth, so it cannot pay a process-spawn
 * per event — instead it keeps ONE long-lived PowerShell helper that loads the
 * Win32 entry points once and then applies commands streamed to its stdin.
 *
 * Host-side, operator-only, and as powerful as the keystroke relay: it is
 * gated to Touchpad desklets and shares the CONTEXTRAIL_REMOTE_CONTROL=0 kill
 * switch. Windows-only (mac/Linux would need an equivalent helper).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from '../core/logger.js';

export interface MouseOp {
  op: 'move' | 'click' | 'double' | 'down' | 'up' | 'scroll' | 'hscroll';
  dx?: number;
  dy?: number;
  button?: 'left' | 'right' | 'middle';
}

/** Translate a mouse op into a single helper-protocol line (or null to skip). */
export function encodeMouse(o: MouseOp): string | null {
  const i = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 0);
  switch (o.op) {
    case 'move': {
      const dx = i(o.dx);
      const dy = i(o.dy);
      return dx === 0 && dy === 0 ? null : `M ${dx} ${dy}`;
    }
    case 'click':
      return o.button === 'right' ? 'R' : o.button === 'middle' ? 'Mi' : 'L';
    case 'double':
      return 'D';
    case 'down':
      return o.button === 'right' ? 'RD' : 'LD';
    case 'up':
      return o.button === 'right' ? 'RU' : 'LU';
    case 'scroll': {
      const d = i(o.dy);
      return d === 0 ? null : `S ${d}`;
    }
    case 'hscroll': {
      const d = i(o.dx);
      return d === 0 ? null : `H ${d}`;
    }
    default:
      return null;
  }
}

/** The PowerShell stdin loop that applies mouse commands via Win32. */
const HELPER = `
$src = @"
using System; using System.Runtime.InteropServices;
public class CRm {
 [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);
}
"@
Add-Type $src
$LD=0x02;$LU=0x04;$RD=0x08;$RU=0x10;$MD=0x20;$MU=0x40;$W=0x800;$HW=0x1000
while(($line=[Console]::In.ReadLine()) -ne $null){
 $a=$line.Split(' ')
 try { switch($a[0]){
  'M' { $p=New-Object CRm+P; [void][CRm]::GetCursorPos([ref]$p); [void][CRm]::SetCursorPos($p.X+[int]$a[1],$p.Y+[int]$a[2]) }
  'L' { [CRm]::mouse_event($LD,0,0,0,[IntPtr]::Zero); [CRm]::mouse_event($LU,0,0,0,[IntPtr]::Zero) }
  'R' { [CRm]::mouse_event($RD,0,0,0,[IntPtr]::Zero); [CRm]::mouse_event($RU,0,0,0,[IntPtr]::Zero) }
  'Mi'{ [CRm]::mouse_event($MD,0,0,0,[IntPtr]::Zero); [CRm]::mouse_event($MU,0,0,0,[IntPtr]::Zero) }
  'D' { [CRm]::mouse_event($LD,0,0,0,[IntPtr]::Zero); [CRm]::mouse_event($LU,0,0,0,[IntPtr]::Zero); [CRm]::mouse_event($LD,0,0,0,[IntPtr]::Zero); [CRm]::mouse_event($LU,0,0,0,[IntPtr]::Zero) }
  'LD'{ [CRm]::mouse_event($LD,0,0,0,[IntPtr]::Zero) }
  'LU'{ [CRm]::mouse_event($LU,0,0,0,[IntPtr]::Zero) }
  'RD'{ [CRm]::mouse_event($RD,0,0,0,[IntPtr]::Zero) }
  'RU'{ [CRm]::mouse_event($RU,0,0,0,[IntPtr]::Zero) }
  'S' { $d=[int]$a[1]; $u=[uint32]([int64]$d -band 0xFFFFFFFF); [CRm]::mouse_event($W,0,0,$u,[IntPtr]::Zero) }
  'H' { $d=[int]$a[1]; $u=[uint32]([int64]$d -band 0xFFFFFFFF); [CRm]::mouse_event($HW,0,0,$u,[IntPtr]::Zero) }
 } } catch {}
}
`;

export class MouseControl {
  private proc: ChildProcessWithoutNullStreams | undefined;

  constructor(private readonly log: Logger) {}

  enabled(): boolean {
    return process.platform === 'win32' && process.env['CONTEXTRAIL_REMOTE_CONTROL'] !== '0';
  }

  handle(op: MouseOp): void {
    if (!this.enabled()) return;
    const line = encodeMouse(op);
    if (!line) return;
    this.write(line);
  }

  /** Release any held buttons (called when a Touchpad desklet disconnects). */
  releaseAll(): void {
    if (!this.enabled() || !this.proc) return;
    this.write('LU');
    this.write('RU');
  }

  stop(): void {
    try {
      this.proc?.stdin.end();
      this.proc?.kill();
    } catch {
      /* already gone */
    }
    this.proc = undefined;
  }

  private write(line: string): void {
    try {
      this.ensure().stdin.write(line + '\n');
    } catch (err) {
      this.log.warn('mouse helper write failed; restarting', { err: (err as Error).message });
      this.proc = undefined;
    }
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc && !this.proc.killed) return this.proc;
    const encoded = Buffer.from(HELPER, 'utf16le').toString('base64');
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
    p.on('error', (err) => this.log.warn('mouse helper error', { err: err.message }));
    p.on('exit', () => { if (this.proc === p) this.proc = undefined; });
    p.stderr?.on('data', (c) => this.log.warn('mouse helper stderr', { msg: String(c).slice(0, 200) }));
    this.proc = p;
    this.log.info('mouse helper started');
    return p;
  }
}
