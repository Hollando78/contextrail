/**
 * Channel Multiplexer (XPT).
 *
 * Delivers each role-scoped context frame to every connection whose role matches
 * the frame's scope, and forwards inbound desklet intent frames to the Intent
 * Router. Uses per-socket send queues so a slow socket cannot head-of-line-block
 * others, meeting the ≤ 5 ms dispatch budget for up to 16 connections.
 * (SUB-XPT-042, IFC-XPT-041, IFC-XPT-042, ARC-REQ-014)
 */
import type { Logger } from '../core/logger.js';
import type { RoleProjection, WsFrame } from '../core/types.js';
import { ContextAccessGuard } from '../slm/context-access-guard.js';
import type { ConnectionRegistry } from './connection-registry.js';

export class ChannelMultiplexer {
  private seq = 0;

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly guard: ContextAccessGuard,
    private readonly log: Logger,
  ) {}

  /** Deliver a role-scoped projection to the matching desklet connection(s). */
  deliverProjection(projection: RoleProjection): void {
    // Final fail-closed check before anything leaves the host. (SUB-SLM-005/006)
    const verdict = this.guard.inspect(projection);
    if (!verdict.allowed) {
      this.log.error('projection blocked by access guard', { reason: verdict.reason, role: projection.role });
      return;
    }

    const frame: WsFrame = {
      kind: 'context',
      seq: ++this.seq,
      role: projection.role,
      timestamp: new Date().toISOString(),
      payload: {
        contextObjectId: projection.contextObjectId,
        deltaFields: projection.deltaFields,
        version: projection.version,
        digest: projection.digest,
        stale: projection.stale,
      },
    };

    // Deliver to the specific desklet if addressed, else all of that role.
    const targets =
      projection.deskletId && this.registry.get(projection.deskletId)
        ? [this.registry.get(projection.deskletId)!]
        : this.registry.forRole(projection.role);

    for (const conn of targets) {
      if (conn.role !== projection.role) continue;
      this.send(conn.deskletId, frame);
    }
  }

  /** Send a frame to one connection through its per-socket queue. */
  send(deskletId: string, frame: WsFrame): void {
    const conn = this.registry.get(deskletId);
    if (!conn) return;
    if (conn.socket.readyState !== conn.socket.OPEN) return;
    conn.queued++;
    conn.socket.send(JSON.stringify(frame), (err) => {
      conn.queued--;
      if (err) this.log.warn('frame send failed', { deskletId, err: err.message });
    });
  }
}
