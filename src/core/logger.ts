/**
 * Structured logger. Emits one JSON object per line to stderr so logs are
 * machine-parseable and never interleave with desklet bundle output on stdout.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel =
  (process.env['CONTEXTRAIL_LOG_LEVEL'] as LogLevel | undefined) ?? 'info';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/** A trimmed log record retained in the in-memory ring for the Logs role. */
export interface LogRecord {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
}

// Bounded ring of recently-emitted records so the Logs desklet can show a live
// host tail without re-reading stderr. Holds only emitted lines (post-threshold).
const RING_MAX = 200;
const ring: LogRecord[] = [];

/** The most recent emitted log records (oldest→newest), capped at `limit`. */
export function recentLogs(limit = 50): LogRecord[] {
  return limit >= ring.length ? ring.slice() : ring.slice(ring.length - limit);
}

function emit(scope: string, level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[threshold]) return;
  const ts = new Date().toISOString();
  const record = { ts, level, scope, msg, ...(fields ?? {}) };
  process.stderr.write(JSON.stringify(record) + '\n');
  ring.push({ ts, level, scope, msg });
  if (ring.length > RING_MAX) ring.shift();
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit(scope, 'debug', m, f),
    info: (m, f) => emit(scope, 'info', m, f),
    warn: (m, f) => emit(scope, 'warn', m, f),
    error: (m, f) => emit(scope, 'error', m, f),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const rootLogger = createLogger('contextrail');
