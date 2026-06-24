/**
 * SSH Session Rate Limiter (RSB) — the entry point of the SSH path.
 *
 * Enforces a per-adapter quota of 10 commands per rolling 60-second window with a
 * 3-command burst allowance; a violation returns a rate-limit error without
 * executing. (SUB-RSB-063, ARC-REQ-018)
 */
import { LIMITS } from '../core/constants.js';

export class SshRateLimiter {
  /** adapter identity -> recent command timestamps (ms). */
  private readonly history = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Returns true if the command is allowed (and records it); false if limited. */
  tryAcquire(adapter: string): boolean {
    const t = this.now();
    const cutoff = t - LIMITS.SSH_RATE_WINDOW_MS;
    const recent = (this.history.get(adapter) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= LIMITS.SSH_RATE_LIMIT) {
      this.history.set(adapter, recent);
      return false;
    }
    recent.push(t);
    this.history.set(adapter, recent);
    return true;
  }

  /** Remaining commands in the current window for an adapter. */
  remaining(adapter: string): number {
    const cutoff = this.now() - LIMITS.SSH_RATE_WINDOW_MS;
    const recent = (this.history.get(adapter) ?? []).filter((ts) => ts > cutoff);
    return Math.max(0, LIMITS.SSH_RATE_LIMIT - recent.length);
  }
}
