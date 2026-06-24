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

function emit(scope: string, level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[threshold]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(fields ?? {}),
  };
  process.stderr.write(JSON.stringify(record) + '\n');
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
