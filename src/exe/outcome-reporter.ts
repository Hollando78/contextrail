/**
 * Outcome Reporter (EXE).
 *
 * Publishes a CommandOutcome to the Workspace Context Store event bus within
 * 10 ms of receiving a ProcessResult, carrying the intent id, status, exit code,
 * stdout digest, truncation flag, and elapsed milliseconds. (SUB-EXE-024,
 * IFC-EXE-018/030)
 */
import type { EventBus } from '../core/bus.js';
import type { CommandOutcome } from '../core/types.js';
import type { ProcessResult } from './process-supervisor.js';

export class OutcomeReporter {
  constructor(private readonly bus: EventBus) {}

  report(result: ProcessResult): CommandOutcome {
    const outcome: CommandOutcome = {
      intentId: result.intentId,
      status: result.status,
      exitCode: result.exitCode,
      stdoutDigest: result.stdoutDigest,
      truncated: result.truncated,
      elapsedMs: result.elapsedMs,
    };
    // WCS consumes this to update context and stream to Logs/Status desklets.
    this.bus.emit('command:outcome', outcome);
    return outcome;
  }
}
