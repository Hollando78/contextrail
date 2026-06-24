/**
 * Dispatch Confirmer (INT).
 *
 * Delivers an outcome (SUCCESS, FAILURE, TIMEOUT, DENIED, SUPERSEDED) to the
 * originating desklet within 200 ms of intent receipt, and proactively emits
 * TIMEOUT if no downstream outcome arrives within that budget. Each intent's
 * desklet ack is emitted exactly once. (SUB-INT-012, IFC-INT-013)
 */
import type { EventBus } from '../core/bus.js';
import { TIMING } from '../core/constants.js';
import type { Intent, IntentStatus } from '../core/types.js';

export class DispatchConfirmer {
  constructor(private readonly bus: EventBus) {}

  /** Begin tracking an intent; returns a settle() to call with the real outcome. */
  begin(intent: Intent): { settle: (status: IntentStatus, detail?: unknown) => void } {
    let done = false;
    const emit = (status: IntentStatus, detail?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.bus.emit('intent:outcome', {
        intentId: intent.intentId,
        correlationId: intent.correlationId,
        deskletId: intent.deskletId,
        status,
        ...(detail !== undefined ? { detail } : {}),
      });
    };
    const timer = setTimeout(() => emit('TIMEOUT', { reason: 'TIMEOUT' }), TIMING.DISPATCH_CONFIRM_MS);
    timer.unref?.();
    return { settle: emit };
  }
}
