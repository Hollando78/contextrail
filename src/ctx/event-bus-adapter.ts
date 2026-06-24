/**
 * Event Bus Adapter (CTX).
 *
 * The sole write/ingestion path into the Context Object Registry (ARC-REQ-012).
 * Subscribes to host workspace events (tool open/close, focus change, project
 * switch, command-execution outcome), translates each into a registry write
 * within 30 ms, and emits ContextUpdated per write. (SUB-CTX-032)
 *
 * Enforces a bounded ingestion queue of at most 200 pending operations with
 * drop-oldest eviction; on overflow it increments a counter and emits
 * ContextOverflow within 10 ms of the first dropped event. (SUB-CTX-079)
 */
import { LIMITS } from '../core/constants.js';
import type { Logger } from '../core/logger.js';
import type { ContextObjectRegistry, WriteRequest } from './context-object-registry.js';

export interface WorkspaceEvent {
  type:
    | 'tool-open'
    | 'tool-close'
    | 'focus-change'
    | 'project-switch'
    | 'command-outcome'
    | 'tool-status'
    | 'raw';
  /** Direct attribute writes this event implies. */
  writes: WriteRequest[];
  /** Optional command-history entry. */
  history?: unknown;
}

export class EventBusAdapter {
  private readonly queue: WorkspaceEvent[] = [];
  private draining = false;
  private overflowCount = 0;

  constructor(
    private readonly registry: ContextObjectRegistry,
    private readonly log: Logger,
    private readonly onUpdated: (objectId: string, fields: string[], version: number) => void,
    private readonly onOverflow: (dropped: number) => void,
  ) {}

  /** Enqueue a workspace event for ingestion. Applies drop-oldest at capacity. */
  ingest(event: WorkspaceEvent): void {
    if (this.queue.length >= LIMITS.CTX_QUEUE_MAX) {
      this.queue.shift(); // drop oldest
      const firstDrop = this.overflowCount === 0;
      this.overflowCount += 1;
      if (firstDrop) {
        // Emit ContextOverflow within 10 ms of the first dropped event.
        this.onOverflow(this.overflowCount);
        this.log.warn('context ingestion overflow — dropping oldest', {
          capacity: LIMITS.CTX_QUEUE_MAX,
        });
      }
    }
    this.queue.push(event);
    this.scheduleDrain();
  }

  get overflows(): number {
    return this.overflowCount;
  }

  get pending(): number {
    return this.queue.length;
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    try {
      let event: WorkspaceEvent | undefined;
      while ((event = this.queue.shift())) {
        this.apply(event);
      }
    } finally {
      this.draining = false;
      if (this.queue.length) this.scheduleDrain();
    }
  }

  private apply(event: WorkspaceEvent): void {
    const touchedByObject = new Map<string, { fields: Set<string>; version: number }>();
    for (const write of event.writes) {
      try {
        const r = this.registry.write(write);
        const entry = touchedByObject.get(r.contextObjectId) ?? { fields: new Set(), version: 0 };
        entry.fields.add(r.attributeName);
        entry.version = r.version;
        touchedByObject.set(r.contextObjectId, entry);
      } catch (err) {
        this.log.warn('rejected malformed write', {
          attributePath: write.attributePath,
          err: (err as Error).message,
        });
      }
    }
    if (event.history !== undefined) {
      const r = this.registry.appendHistory(event.history);
      const entry = touchedByObject.get(r.contextObjectId) ?? { fields: new Set(), version: 0 };
      entry.fields.add(r.attributeName);
      entry.version = r.version;
      touchedByObject.set(r.contextObjectId, entry);
    }
    for (const [objectId, { fields, version }] of touchedByObject) {
      this.onUpdated(objectId, [...fields], version);
    }
  }
}
