/**
 * Data-intent handlers (INT).
 *
 * Capture notes and AI queries are not executor commands — they are in-process
 * data operations on the Workspace Context Store. They are role-scoped by
 * default-deny: only a Capture-bound desklet may capture, only an AI-bound
 * desklet may query the assistant. (SYS-REQ-007, FN-FN-010)
 */
import type { DataIntentHandler } from './intent-dispatcher.js';

/** The Workspace Context Store surface these handlers need. */
export interface CaptureAndAssistant {
  addCapture(text: string): unknown;
  runAssistant(query: string): unknown;
}

/** The Actions Registry surface the propose handler needs. */
export interface ActionProposer {
  propose(input: Record<string, unknown>, by: string): { proposalId: string };
}

/** Opens the host-side Claude Code action-authoring console. */
export type ConsoleLauncher = () => { ok: boolean; dir?: string; error?: string };

/** Remote-control surface for the Remote desklet role. */
export interface RemotePort {
  enabled(): boolean;
  focus(windowId: string): Promise<boolean>;
  type(windowId: string, text: string, enter: boolean): Promise<boolean>;
  key(windowId: string, name: string): Promise<boolean>;
  /** Re-enumerate + re-stream the window list immediately. */
  refresh(): void;
}

export function buildDataHandlers(
  store: CaptureAndAssistant | undefined,
  actions?: ActionProposer | undefined,
  launchConsole?: ConsoleLauncher | undefined,
  remote?: RemotePort | undefined,
): Record<string, DataIntentHandler> {
  const remoteGuard = (intent: { role: string }): { status: 'DENIED' | 'FAILURE' } | null => {
    if (intent.role !== 'Remote') return { status: 'DENIED' };
    if (!remote || !remote.enabled()) return { status: 'FAILURE' };
    return null;
  };
  return {
    // Remote-control intents (Remote role only, default-deny). They focus a host
    // window and relay input — e.g. typing "continue" into a Claude terminal.
    'remote-refresh': async (intent) => {
      const bad = remoteGuard(intent);
      if (bad) return { status: bad.status, detail: { reason: bad.status === 'DENIED' ? 'PERMISSION_DENIED' : 'REMOTE_DISABLED' } };
      remote!.refresh();
      return { status: 'SUCCESS' };
    },
    'remote-focus': async (intent) => {
      const bad = remoteGuard(intent);
      if (bad) return { status: bad.status, detail: { reason: bad.status === 'DENIED' ? 'PERMISSION_DENIED' : 'REMOTE_DISABLED' } };
      const id = String((intent.payload as { windowId?: unknown }).windowId ?? '');
      const ok = await remote!.focus(id);
      return ok ? { status: 'SUCCESS' } : { status: 'FAILURE', detail: { reason: 'FOCUS_FAILED' } };
    },
    'remote-type': async (intent) => {
      const bad = remoteGuard(intent);
      if (bad) return { status: bad.status, detail: { reason: bad.status === 'DENIED' ? 'PERMISSION_DENIED' : 'REMOTE_DISABLED' } };
      const p = intent.payload as { windowId?: unknown; text?: unknown; enter?: unknown };
      const id = String(p.windowId ?? '');
      const text = String(p.text ?? '');
      if (!id || !text) return { status: 'FAILURE', detail: { reason: 'INVALID_REQUEST' } };
      const ok = await remote!.type(id, text, p.enter !== false);
      return ok ? { status: 'SUCCESS' } : { status: 'FAILURE', detail: { reason: 'SEND_FAILED' } };
    },
    'remote-key': async (intent) => {
      const bad = remoteGuard(intent);
      if (bad) return { status: bad.status, detail: { reason: bad.status === 'DENIED' ? 'PERMISSION_DENIED' : 'REMOTE_DISABLED' } };
      const p = intent.payload as { windowId?: unknown; key?: unknown };
      const id = String(p.windowId ?? '');
      const key = String(p.key ?? '');
      if (!id || !key) return { status: 'FAILURE', detail: { reason: 'INVALID_REQUEST' } };
      const ok = await remote!.key(id, key);
      return ok ? { status: 'SUCCESS' } : { status: 'FAILURE', detail: { reason: 'SEND_FAILED' } };
    },
    // An AI desklet may ask the host to open the Claude Code action-authoring
    // console (an interactive terminal on the operator's machine).
    'launch-console': async (intent) => {
      if (intent.role !== 'AI') return { status: 'DENIED', detail: { reason: 'PERMISSION_DENIED' } };
      if (!launchConsole) return { status: 'FAILURE', detail: { reason: 'INTERNAL_ERROR' } };
      const r = launchConsole();
      return r.ok ? { status: 'SUCCESS', detail: { dir: r.dir } } : { status: 'FAILURE', detail: { reason: r.error } };
    },
    // An Actions desklet may PROPOSE an action; it never activates until the
    // operator approves it on the host console. SSH actions are operator-only.
    'action-propose': async (intent) => {
      if (intent.role !== 'Actions') return { status: 'DENIED', detail: { reason: 'PERMISSION_DENIED' } };
      if (!actions) return { status: 'FAILURE', detail: { reason: 'INTERNAL_ERROR' } };
      const p = intent.payload as Record<string, unknown>;
      if (p['kind'] === 'ssh') return { status: 'DENIED', detail: { reason: 'SSH_ACTIONS_ARE_OPERATOR_ONLY' } };
      try {
        const proposal = actions.propose(p, intent.deskletId);
        return { status: 'SUCCESS', detail: { proposalId: proposal.proposalId } };
      } catch (err) {
        return { status: 'FAILURE', detail: { reason: (err as Error).message } };
      }
    },
    capture: async (intent) => {
      if (intent.role !== 'Capture') return { status: 'DENIED', detail: { reason: 'PERMISSION_DENIED' } };
      if (!store) return { status: 'FAILURE', detail: { reason: 'INTERNAL_ERROR' } };
      const text = String((intent.payload as { text?: unknown }).text ?? '');
      if (!text.trim()) return { status: 'FAILURE', detail: { reason: 'INVALID_REQUEST' } };
      store.addCapture(text);
      return { status: 'SUCCESS' };
    },
    'ai-query': async (intent) => {
      if (intent.role !== 'AI') return { status: 'DENIED', detail: { reason: 'PERMISSION_DENIED' } };
      if (!store) return { status: 'FAILURE', detail: { reason: 'INTERNAL_ERROR' } };
      const query = String((intent.payload as { query?: unknown }).query ?? '');
      if (!query.trim()) return { status: 'FAILURE', detail: { reason: 'INVALID_REQUEST' } };
      store.runAssistant(query);
      return { status: 'SUCCESS' };
    },
  };
}
