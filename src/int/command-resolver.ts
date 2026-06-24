/**
 * Command resolver (INT).
 *
 * Maps a high-level desklet intent to a concrete, gateable CommandEnvelope:
 * an action identifier (for the allowlist gate), an adapter routing id, and the
 * executable + args. Local actions resolve to a safe, real subprocess (a short
 * Node invocation) so the action loop genuinely spawns, captures output, and
 * enforces the timeout without launching anything destructive by default.
 */
import type { Intent, CommandEnvelope } from '../core/types.js';

export interface Resolved {
  envelope: Omit<CommandEnvelope, 'permitId'>;
  /** Principal used for the allowlist gate. */
  principal: string;
  /** Key used for conflict serialisation. */
  conflictKey: string;
}

/** A safe local command that echoes what would run, so execution is real but inert. */
function localEcho(intentId: string, actionId: string, note: string): Omit<CommandEnvelope, 'permitId'> {
  return {
    actionId,
    adapterId: 'local',
    targetPath: process.execPath,
    args: ['-e', `console.log(${JSON.stringify(note)})`],
    env: {},
    intentId,
  };
}

/** Repo URL opened by the 'open-project-urls' profile (override via CR_PROJECT_URL). */
const PROJECT_URL = process.env['CR_PROJECT_URL'] ?? 'https://github.com/Hollando78/contextrail';

/**
 * Build a real "open this on the host" command. Uses the OS launcher
 * (start/open/xdg-open) so it returns immediately — the launched app/browser
 * keeps running independently and isn't caught by the executor's 5s timeout.
 */
function osLaunch(target: string): { targetPath: string; args: string[] } {
  switch (process.platform) {
    case 'win32':
      return { targetPath: 'cmd', args: ['/c', 'start', '', target] };
    case 'darwin':
      return { targetPath: 'open', args: [target] };
    default:
      return { targetPath: 'xdg-open', args: [target] };
  }
}

/** Map a tool profile to a concrete, visible host action. */
function profileCommand(intentId: string, actionId: string, profile: string): Omit<CommandEnvelope, 'permitId'> {
  let launch: { targetPath: string; args: string[] };
  switch (profile) {
    case 'launch-ide':
      launch = process.platform === 'win32' ? osLaunch('notepad')
        : process.platform === 'darwin' ? { targetPath: 'open', args: ['-a', 'TextEdit'] }
        : osLaunch('.');
      break;
    case 'open-project-urls':
      launch = osLaunch(PROJECT_URL);
      break;
    case 'restore-layout':
      launch = process.platform === 'win32' ? { targetPath: 'cmd', args: ['/c', 'start', '', 'explorer', '.'] } : osLaunch('.');
      break;
    default:
      return localEcho(intentId, actionId, `ContextRail: no host command for profile '${profile}'`);
  }
  return { actionId, adapterId: 'local', targetPath: launch.targetPath, args: launch.args, env: {}, intentId, detached: true };
}

export function resolveIntent(intent: Intent): Resolved | null {
  const { type, payload, intentId } = intent;

  switch (type) {
    case 'launch-tool': {
      const profile = String(payload['profile'] ?? 'default');
      const actionId = `launch-tool:${profile}`;
      return {
        envelope: profileCommand(intentId, actionId, profile),
        principal: 'local',
        conflictKey: intent.targetContextObject ?? 'workspace.openTools',
      };
    }
    case 'open-url': {
      const url = String(payload['url'] ?? '');
      const actionId = `open-url:${url}`;
      return {
        envelope: { actionId, adapterId: 'local', ...osLaunch(url), env: {}, intentId, detached: true },
        principal: 'local',
        conflictKey: intent.targetContextObject ?? 'workspace.openTools',
      };
    }
    case 'restore-layout': {
      return {
        envelope: localEcho(intentId, 'restore-layout', 'ContextRail restored window layout'),
        principal: 'local',
        conflictKey: intent.targetContextObject ?? 'workspace.windowLayout',
      };
    }
    case 'ssh-action': {
      // Routed to the Remote Action Gateway ('rag'); the command string is gated.
      const command = String(payload['command'] ?? '');
      const host = String(payload['host'] ?? '');
      return {
        envelope: {
          actionId: command,
          adapterId: 'rag',
          targetPath: '',
          args: [],
          env: { TARGET_HOST: host, COMMAND_CLASS: String(payload['commandClass'] ?? 'bounded') },
          intentId,
        },
        principal: 'rag',
        conflictKey: intent.targetContextObject ?? `ssh:${host}`,
      };
    }
    default:
      return null;
  }
}
