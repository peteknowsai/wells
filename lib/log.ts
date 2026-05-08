// Structured JSON logger to stderr. One JSON object per line (JSONL).
// Level via WELL_LOG_LEVEL: debug | info | warn | error | silent (default: info).
//
// If WELL_LOG_FILE is set, every line is also appended there (in addition to
// stderr). welld sets this on startup when stderr is a TTY — without it,
// manual `bun run daemon/welld.ts` launches leave no artifact when welld
// dies. Launchd-managed welld already redirects stderr to a file, so it
// doesn't set WELL_LOG_FILE (would double-write).

import { openSync, writeSync } from "node:fs";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof LEVELS;

function threshold(): number {
  const env = (process.env.WELL_LOG_LEVEL ?? "info").toLowerCase();
  return (LEVELS as Record<string, number>)[env] ?? LEVELS.info;
}

let tailFd: number | null | undefined; // undefined=unchecked, null=no file, number=open fd
function tail(line: string): void {
  if (tailFd === undefined) {
    const path = process.env.WELL_LOG_FILE;
    if (!path) {
      tailFd = null;
      return;
    }
    try {
      tailFd = openSync(path, "a");
    } catch {
      tailFd = null;
    }
  }
  if (tailFd !== null && tailFd !== undefined) {
    try { writeSync(tailFd, line); } catch { /* best-effort */ }
  }
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  }) + "\n";
  process.stderr.write(line);
  tail(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
