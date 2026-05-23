// Per-VM VirtualMachine.xpc child tracking + targeted kill. Apple's
// Virtualization.framework spawns one `VirtualMachine.xpc` subprocess
// per VZVirtualMachine instance via launchd; the XPC child is where
// the VM's actual VZ kernel state lives.
//
// W.74: replaces the previous `killAndRestartLumeServe` pattern in
// hibernate/wake. Killing lume serve to release VZ state for ONE VM
// also clipped every other running VM (XPC connections broke,
// children terminated). Killing just the target VM's XPC child
// releases its VZ kernel state without disturbing siblings.
//
// Identification is by snapshot-diff: capture the XPC PID set before
// lume.start, then again after, and the new PID is the target VM's
// child. Tracked on `WellRuntime.xpc_child_pid` so hibernate can
// look it up later. See `findVzXpcPids` for the pure list step and
// `waitForNewXpcChild` for the diff-poll.

import { spawn } from "bun";

// VZ XPC service binary identifier. Mirrors the marker in
// `lib/vzXpcCount.ts` (counter) and `engine/vwell-src/src/
// Virtualization/XPCChildLocator.swift` (orphan sweep). Single source
// of truth would be nice but cross-language; keep them in sync.
export const VZ_XPC_MARKER = "Virtualization.VirtualMachine";

// One `ps` row: PID + command line. Exported for testing.
export interface PsRow {
  pid: number;
  command: string;
}

// Pure: parse `ps -A -o pid=,command=` output into rows. Skips
// malformed lines (empty PID, non-numeric) silently — `ps` output
// is well-formed on macOS but defensive parsing avoids tripping on
// rare edge cases (e.g., the very first line during boot).
export function parsePsOutput(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    rows.push({ pid, command: m[2] ?? "" });
  }
  return rows;
}

// Pure: filter `ps` rows to VZ XPC children.
export function filterVzXpcRows(rows: PsRow[]): PsRow[] {
  return rows.filter((r) => r.command.includes(VZ_XPC_MARKER));
}

// Pure: extract just the PIDs from filtered rows. Sorted so set-diff
// callers can rely on stable order.
export function pidsFromRows(rows: PsRow[]): number[] {
  return rows.map((r) => r.pid).sort((a, b) => a - b);
}

// Pure: PIDs in `after` that aren't in `before`. Used after lume.start
// to find the new VM's XPC child. Returns a sorted set.
export function diffNewPids(
  before: readonly number[],
  after: readonly number[],
): number[] {
  const beforeSet = new Set(before);
  return after.filter((p) => !beforeSet.has(p)).sort((a, b) => a - b);
}

// Walk `ps -A` and return the PIDs of every VirtualMachine.xpc on
// the host. Returns [] if `ps` fails (degraded gracefully — caller
// can fall back to non-targeted behavior).
export async function findVzXpcPids(): Promise<number[]> {
  try {
    const proc = spawn(["ps", "-A", "-o", "pid=,command="], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return pidsFromRows(filterVzXpcRows(parsePsOutput(text)));
  } catch {
    return [];
  }
}

// Poll `findVzXpcPids` until a PID not in `before` appears, or
// timeoutMs elapses. Returns the new PID on success, null on
// timeout. Used right after `lume.start` to capture the VM's
// VirtualMachine.xpc child.
//
// Race: if multiple lume.starts run in parallel, two new PIDs
// can appear and we don't know which belongs to which VM. Wells
// serializes startWell at the lifecycle layer (per-well lock),
// but pool refills run in parallel. Callers must serialize their
// start+diff window against other concurrent starts — typically
// by holding the per-well or per-fill lock for the duration.
//
// Default poll cadence is fast (50ms) because the XPC child
// appears within a few hundred ms of lume.start. 5s timeout is
// generous; healthy starts resolve in <500ms.
export async function waitForNewXpcChild(
  before: readonly number[],
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<number | null> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const after = await findVzXpcPids();
    const newPids = diffNewPids(before, after);
    if (newPids.length >= 1) return newPids[0]!;
    await Bun.sleep(pollIntervalMs);
  }
  return null;
}

// True if the given PID currently exists. Cheap probe via SIGNAL 0
// (doesn't deliver a signal — just probes). Returns false on ESRCH
// (no such process). Other errors (EPERM) treated as "alive" —
// better to err on the side of "this PID is still around" than
// assume it's dead. Mirrors XPCChildLocator.swift's `isAlive`.
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ESRCH") return false;
    return true;
  }
}

// SIGKILL `pid` and wait until it's actually gone. Returns true on
// success, false if the kill failed or the PID never went away
// within timeoutMs. Idempotent: a PID that's already dead returns
// true immediately.
//
// VZ kernel state for that VM is released as the XPC child exits.
// Subsequent VZVirtualMachine construction on the same disk path
// gets a fresh kernel namespace.
export async function killXpcChild(
  pid: number,
  options: { timeoutMs?: number; pollIntervalMs?: number; signal?: NodeJS.Signals } = {},
): Promise<boolean> {
  if (!isPidAlive(pid)) return true;
  const signal = options.signal ?? "SIGKILL";
  try {
    process.kill(pid, signal);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // Already gone (ESRCH) is a success — somebody else cleaned it
    // up, or it crashed on its own. Other errors (EPERM = we don't
    // own it) are real failures.
    if (err.code !== "ESRCH") return false;
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await Bun.sleep(pollIntervalMs);
  }
  return false;
}
