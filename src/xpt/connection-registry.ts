/**
 * Connection Registry (XPT).
 *
 * In-process registry of live desklet WebSocket connections, updated within
 * 10 ms of any connect/disconnect, holding desklet ID, socket handle, assigned
 * role, and last-pong timestamp. The Heartbeat Monitor reads it without blocking
 * on writes. (IFC-XPT-039, IFC-XPT-040, SUB-XPT-041)
 */
import type { WebSocket } from 'ws';
import type { Role } from '../core/constants.js';

export interface Connection {
  deskletId: string;
  socket: WebSocket;
  role: Role;
  connectedAt: number;
  lastPong: number;
  /** Per-socket outbound queue depth (head-of-line-blocking guard). (ARC-REQ-014) */
  queued: number;
}

export class ConnectionRegistry {
  private readonly byId = new Map<string, Connection>();

  constructor(private readonly now: () => number = Date.now) {}

  add(deskletId: string, socket: WebSocket, role: Role): Connection {
    const conn: Connection = {
      deskletId,
      socket,
      role,
      connectedAt: this.now(),
      lastPong: this.now(),
      queued: 0,
    };
    this.byId.set(deskletId, conn);
    return conn;
  }

  remove(deskletId: string): void {
    this.byId.delete(deskletId);
  }

  get(deskletId: string): Connection | undefined {
    return this.byId.get(deskletId);
  }

  markPong(deskletId: string): void {
    const c = this.byId.get(deskletId);
    if (c) c.lastPong = this.now();
  }

  /** All connections (read-stable copy). */
  list(): Connection[] {
    return [...this.byId.values()];
  }

  /** Connections bound to a specific role (for role-scoped delivery). */
  forRole(role: Role): Connection[] {
    return this.list().filter((c) => c.role === role);
  }

  size(): number {
    return this.byId.size;
  }
}
