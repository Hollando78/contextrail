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

export function buildDataHandlers(store: CaptureAndAssistant | undefined): Record<string, DataIntentHandler> {
  return {
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
