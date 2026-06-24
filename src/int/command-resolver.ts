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

export function resolveIntent(intent: Intent): Resolved | null {
  const { type, payload, intentId } = intent;

  switch (type) {
    case 'launch-tool': {
      const profile = String(payload['profile'] ?? 'default');
      const actionId = `launch-tool:${profile}`;
      return {
        envelope: localEcho(intentId, actionId, `ContextRail launched tool profile: ${profile}`),
        principal: 'local',
        conflictKey: intent.targetContextObject ?? 'workspace.openTools',
      };
    }
    case 'open-url': {
      const url = String(payload['url'] ?? '');
      const actionId = `open-url:${url}`;
      return {
        envelope: localEcho(intentId, actionId, `ContextRail opened URL: ${url}`),
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
