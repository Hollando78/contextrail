/**
 * In-process event bus.
 *
 * The architecture decisions mandate synchronous, in-process communication on
 * the hot paths (ARC-REQ-008/009/012/016) so the 200 ms round-trip budget is
 * met without IPC overhead. This is a thin, typed wrapper over Node's
 * EventEmitter with synchronous emit semantics.
 */
import { EventEmitter } from 'node:events';
import type { ContextUpdated, RoleProjection, CommandOutcome, Intent } from './types.js';
import type { Mode } from './constants.js';

/** The canonical set of bus events and their payload types. */
export interface BusEvents {
  // Mode / lifecycle
  'mode:changed': { from: Mode; to: Mode; reason?: string };
  'subsystem:failed': { subsystem: string; timestamp: string };
  'subsystem:recovered': { subsystem: string; timestamp: string };
  'boot:complete': { subsystems: string[] };
  'boot:failed': { subsystem: string; reason: string };

  // Security / lock
  'lock:engaged': { reason: string; timestamp: string };
  'lock:released': { timestamp: string };

  // Context
  'context:updated': ContextUpdated;
  'context:overflow': { dropped: number; timestamp: string };
  'context:projection': RoleProjection;

  // Intents / execution
  'intent:received': Intent;
  'intent:outcome': { intentId: string; correlationId: string; deskletId: string; status: string; detail?: unknown };
  'command:outcome': CommandOutcome;

  // Desklet liveness
  'desklet:paired': { deskletId: string; role: string };
  'desklet:linklost': { deskletId: string };
  'desklet:reconnected': { deskletId: string };
  'desklet:lastDisconnected': Record<string, never>;

  // Adapters
  'adapter:registered': { adapterId: string };
  'adapter:deregistered': { adapterId: string };
  'policy:changed': Record<string, never>;
}

export type BusEventName = keyof BusEvents;

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many subsystems subscribe to the same events (e.g. lock:engaged).
    this.emitter.setMaxListeners(100);
  }

  on<E extends BusEventName>(event: E, handler: (payload: BusEvents[E]) => void): () => void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    return () => this.emitter.off(event, handler as (...args: unknown[]) => void);
  }

  once<E extends BusEventName>(event: E, handler: (payload: BusEvents[E]) => void): void {
    this.emitter.once(event, handler as (...args: unknown[]) => void);
  }

  emit<E extends BusEventName>(event: E, payload: BusEvents[E]): void {
    this.emitter.emit(event, payload);
  }

  /** Await the next occurrence of an event, with an optional timeout. */
  waitFor<E extends BusEventName>(event: E, timeoutMs?: number): Promise<BusEvents[E]> {
    return new Promise((resolve, reject) => {
      const handler = (payload: BusEvents[E]) => {
        if (timer) clearTimeout(timer);
        resolve(payload);
      };
      const timer = timeoutMs
        ? setTimeout(() => {
            this.emitter.off(event, handler as (...args: unknown[]) => void);
            reject(new Error(`timeout waiting for ${event}`));
          }, timeoutMs)
        : undefined;
      this.emitter.once(event, handler as (...args: unknown[]) => void);
    });
  }
}
