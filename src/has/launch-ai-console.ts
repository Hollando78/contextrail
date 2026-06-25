/**
 * Launch the guardrailed Claude Code "AI console" workspace in a host terminal.
 * Shared by the loopback admin route and the AI-desklet `launch-console` intent.
 * Host-side only — it opens an interactive terminal on the operator's machine.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Logger } from '../core/logger.js';

export function launchAiConsole(log?: Logger): { ok: boolean; dir?: string; error?: string } {
  const dir = join(process.cwd(), 'ai-console');
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', 'ContextRail AI Console', 'cmd', '/k', `cd /d "${dir}" && claude`], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell application "Terminal" to do script "cd \\"${dir}\\" && claude"`], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', `bash -lc 'cd "${dir}" && claude'`], { detached: true, stdio: 'ignore' }).unref();
    }
    log?.info('AI console launched', { dir });
    return { ok: true, dir };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
