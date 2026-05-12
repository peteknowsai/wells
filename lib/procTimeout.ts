// Race a spawned subprocess against a wall-clock timeout. SIGKILL on
// timeout (more reliable than SIGTERM when sshd is the parent). Returns
// the exit code, or throws on timeout.
//
// Lifted from lib/rinseWell.ts to a shared helper because every ssh-spawn
// site needed the same pattern. Specific incident motivating the wall-
// clock timeout: B.0.11.b cells team 2026-05-09, rinseGuest's ssh
// blocked for 5+ minutes because ConnectTimeout only covers handshake
// (not in-session stalls).

import type { spawn } from "bun";

export async function runProcWithTimeout(
  proc: ReturnType<typeof spawn>,
  timeoutMs: number,
  description: string,
): Promise<number> {
  const TIMEOUT = Symbol("timeout");
  const timer = new Promise<typeof TIMEOUT>((resolve) =>
    setTimeout(() => resolve(TIMEOUT), timeoutMs),
  );
  const result = await Promise.race([proc.exited, timer]);
  if (result === TIMEOUT) {
    try {
      proc.kill("SIGKILL");
    } catch {}
    // Best-effort drain so the spawned proc's stdio fds can close.
    await proc.exited.catch(() => 0);
    throw new Error(`${description} timed out after ${timeoutMs}ms`);
  }
  return result as number;
}
