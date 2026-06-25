#!/usr/bin/env node
/**
 * ContextRail AI-console guardrail (PreToolUse hook).
 *
 * Hard-blocks destructive shell commands regardless of the permission allowlist,
 * as defence in depth while Claude authors and tests actions on this machine.
 * Receives the tool call as JSON on stdin; exit code 2 blocks the call and shows
 * the reason to Claude. (Mirrors ContextRail's default-deny posture.)
 */
import { readFileSync } from 'node:fs';

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  process.exit(0); // no input — don't block
}

let data = {};
try {
  data = JSON.parse(raw);
} catch {
  process.exit(0);
}

const tool = data.tool_name ?? '';
const input = data.tool_input ?? {};
const command = String(input.command ?? '');

// Patterns that delete data, wipe disks, or reconfigure the machine destructively.
const DESTRUCTIVE = [
  /\brm\s+-[a-z]*\s*r/i, // rm -rf and variants
  /\brm\s+-[a-z]*f/i,
  /\brmdir\s+\/s/i,
  /\bdel\s+\/[sq]/i,
  /\berase\b/i,
  /\bformat\b\s+[a-z]:/i,
  /\bmkfs/i,
  /\bdiskpart\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\breg\s+delete/i,
  /Remove-Item\b[^\n]*-Recurse/i,
  /Remove-Item\b[^\n]*-Force/i,
  /\bRemove-Item\b\s+[^\n]*[\\/]/i,
  /\b(sudo|runas)\b/i,
  /\bgit\b[^\n]*\bpush\b[^\n]*--force/i,
  /\bgit\s+reset\s+--hard/i,
  /:\s*\(\)\s*\{\s*:\|:/, // fork bomb
  />\s*\/dev\/sd/i,
];

if (tool === 'Bash' && DESTRUCTIVE.some((re) => re.test(command))) {
  console.error(
    'ContextRail guardrail: blocked a potentially destructive command. ' +
      'Actions you author must never delete data, wipe disks, force-push, or escalate privileges. ' +
      'Rework the request into a safe, reversible action.',
  );
  process.exit(2); // block
}

process.exit(0); // allow / defer to the permission allowlist
