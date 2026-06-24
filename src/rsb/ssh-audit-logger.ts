/**
 * SSH Audit Logger (RSB).
 *
 * Append-only audit of every SSH execution attempt, including denied ones,
 * governed under ISO/IEC 27001 Annex A 8.15 with a 90-day minimum retention.
 * Records only command text, target host, adapter identity, allowlist verdict,
 * duration, and result code — never credentials, private-key material, or
 * retrieved file content (GDPR Art. 5(1)(c) data minimisation). (SUB-RSB-062,
 * SUB-RSB-075/076, ARC-REQ-020)
 */
import { appendFile, readFile, writeFile, rename } from 'node:fs/promises';
import type { Logger } from '../core/logger.js';
import { AUDIT } from '../core/constants.js';

export interface SshAuditRecord {
  timestamp: string; // ISO 8601
  command: string;
  targetHost: string;
  adapter: string;
  verdict: 'permit' | 'deny' | 'rate-limited' | 'error' | 'timeout' | 'locked';
  exitCode: number;
  durationMs: number;
  reason?: string;
}

export class SshAuditLogger {
  constructor(
    private readonly path: string,
    private readonly log: Logger,
  ) {}

  record(rec: SshAuditRecord): Promise<void> {
    return appendFile(this.path, JSON.stringify(rec) + '\n', 'utf8').catch((err) => {
      this.log.error('failed to write SSH audit record', { err: (err as Error).message });
    });
  }

  /** Drop records older than the retention window (≥ 90 days). Integrity-preserving rewrite. */
  async prune(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return;
    }
    const cutoff = Date.now() - AUDIT.SSH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const kept = text
      .split('\n')
      .filter((l) => l.trim())
      .filter((l) => {
        try {
          return Date.parse((JSON.parse(l) as SshAuditRecord).timestamp) >= cutoff;
        } catch {
          return false;
        }
      });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    await rename(tmp, this.path);
  }
}
