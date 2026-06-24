/**
 * Conflict Serialiser (INT).
 *
 * Maintains a per-context-object queue so conflicting intents that target the
 * same object are applied in receipt order. While one intent for an object is
 * executing, a single later intent may wait; if a newer one arrives it supersedes
 * the waiting one, which is reported as SUPERSEDED rather than applied (last
 * pending wins, executing intent always completes). (SUB-INT-013, SYS-REQ-010,
 * IFC-INT-011/012)
 */
type Slot = 'run' | 'superseded';

interface Waiter {
  resolve: (slot: Slot) => void;
}

interface ObjectState {
  running: boolean;
  pending?: Waiter;
}

export class ConflictSerialiser {
  private readonly objects = new Map<string, ObjectState>();

  /** Acquire the right to act on `key`. Resolves 'run' when it's this intent's turn. */
  acquire(key: string): Promise<Slot> {
    let st = this.objects.get(key);
    if (!st) {
      st = { running: false };
      this.objects.set(key, st);
    }
    if (!st.running) {
      st.running = true;
      return Promise.resolve('run');
    }
    // Something is running. Supersede any already-waiting intent.
    if (st.pending) {
      st.pending.resolve('superseded');
      st.pending = undefined;
    }
    return new Promise<Slot>((resolve) => {
      st!.pending = { resolve };
    });
  }

  /** Release after acting on `key`, promoting any waiting intent. */
  release(key: string): void {
    const st = this.objects.get(key);
    if (!st) return;
    if (st.pending) {
      const next = st.pending;
      st.pending = undefined;
      st.running = true;
      next.resolve('run');
    } else {
      this.objects.delete(key);
    }
  }
}
