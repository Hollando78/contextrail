#!/usr/bin/env node
/**
 * ContextRail login helper (best-effort, host-side).
 *
 * Invoked by a `login` action via the Process Supervisor, which injects the
 * resolved credentials into the environment at spawn time:
 *   CR_LOGIN_URL  — the page to open
 *   CR_LOGIN_USER — username  (from the vault, never stored in the action)
 *   CR_LOGIN_PASS — password  (from the vault)
 *   CR_LOGIN_DELAY_MS    — wait before typing (default 4500)
 *   CR_LOGIN_SUBMIT      — "1" to press Enter after the password (default 1)
 *
 * It opens the URL in the default browser, waits for the page, then types the
 * username, Tab, the password, and Enter via OS keystroke simulation. This is
 * intentionally simple and site-agnostic; the ContextRail AI console is expected
 * to TUNE the delay/sequence per site (or replace this helper) and TEST the
 * result. Keystroke simulation types into whatever window is focused — only run
 * it when the freshly-opened browser tab is frontmost.
 *
 * Secrets are read from the environment only; they are never written to disk,
 * logged, or passed as command-line arguments.
 */
import { spawn } from 'node:child_process';

const url = process.env.CR_LOGIN_URL ?? '';
const delayMs = Number(process.env.CR_LOGIN_DELAY_MS ?? '4500');
const submit = (process.env.CR_LOGIN_SUBMIT ?? '1') !== '0';

if (!url) {
  console.error('login-helper: CR_LOGIN_URL is required');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openUrl(u) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', u], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [u], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [u], { detached: true, stdio: 'ignore' }).unref();
}

/** Type the credentials into the focused window via OS keystroke simulation. */
function typeCredentials() {
  if (process.platform === 'win32') {
    // PowerShell SendKeys reads the secrets from this process's environment, so
    // they never appear on a command line. SendKeys treats {}()+^%~ specially;
    // the AI console should escape those in the secret if a site needs it.
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '[System.Windows.Forms.SendKeys]::SendWait($env:CR_LOGIN_USER);',
      'Start-Sleep -Milliseconds 350;',
      "[System.Windows.Forms.SendKeys]::SendWait('{TAB}');",
      'Start-Sleep -Milliseconds 350;',
      '[System.Windows.Forms.SendKeys]::SendWait($env:CR_LOGIN_PASS);',
      submit ? "Start-Sleep -Milliseconds 350; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}');" : '',
    ].join(' ');
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', env: process.env });
    return;
  }
  if (process.platform === 'darwin') {
    const tab = 'tell application "System Events" to keystroke tab';
    const ret = 'tell application "System Events" to keystroke return';
    const typeUser = 'tell application "System Events" to keystroke (system attribute "CR_LOGIN_USER")';
    const typePass = 'tell application "System Events" to keystroke (system attribute "CR_LOGIN_PASS")';
    const script = [typeUser, 'delay 0.35', tab, 'delay 0.35', typePass, submit ? 'delay 0.35\n' + ret : ''].join('\n');
    spawn('osascript', ['-e', script], { stdio: 'ignore', env: process.env });
    return;
  }
  // Linux: requires xdotool.
  const user = process.env.CR_LOGIN_USER ?? '';
  const pass = process.env.CR_LOGIN_PASS ?? '';
  const seq = `sleep 0.1; xdotool type --clearmodifiers '${user}'; xdotool key Tab; xdotool type --clearmodifiers '${pass}';` + (submit ? ' xdotool key Return;' : '');
  spawn('sh', ['-c', seq], { stdio: 'ignore', env: process.env });
}

openUrl(url);
await sleep(delayMs);
typeCredentials();
