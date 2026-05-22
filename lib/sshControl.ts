// SSH ControlMaster — connection multiplexing for welld's exec calls.
//
// Without this, every `well exec` (and every cells-team mother→cell call)
// spawns a fresh ssh process and pays ~150ms for TCP + key exchange + auth
// before the command even runs. With ControlMaster, the first call opens
// a master tunnel; subsequent calls reuse it at ~10ms latency. ~20×
// improvement on the per-call tax.
//
// Two-step pattern:
// 1. `ensureSshMaster()` spawns `ssh -fN -M` once per (well, ip) when
//    needed. Detached + unref'd so the master persists past welld's
//    spawning context. Without detached, Bun/Node tear down the master
//    when the spawning ssh client exits — verified: `ControlMaster=auto`
//    in a single spawn doesn't leave a surviving socket.
// 2. exec spawns just pass `ControlPath=... ControlMaster=no` to use
//    the existing master. No connection setup cost.
//
// Lifetime: master persists `ControlPersist` seconds after the last
// client. Stop/destroy closes it via `ssh -O exit` so stale sockets
// don't accumulate.

import { spawn as cpSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";

import { PATHS } from "./state.ts";

// Keep the master alive 10 minutes past the last client. Long enough
// to amortize across a multi-step birth ritual (~8 calls), short enough
// that a forgotten socket doesn't pin a stopped well's tunnel.
const CONTROL_PERSIST_SECONDS = 600;

// Path length cap on macOS UNIX sockets is ~104 chars. With stateRoot
// at `~/.wells/ssh-control/` and per-well names like `cells-3.sock`,
// we're well under.
export function sshControlSocket(name: string): string {
  return join(PATHS.sshControl(), `${name}.sock`);
}

// SSH options that REUSE the master. exec spawns use these. They do NOT
// open a master themselves — `ensureSshMaster` does that.
export function sshControlArgs(name: string): string[] {
  return [
    "-o", `ControlPath=${sshControlSocket(name)}`,
    "-o", "ControlMaster=no",
  ];
}

// Spawn an `ssh -fN -M` master in the background. Idempotent: if the
// socket already exists, this is a no-op. Detached + unref so the
// master lives independently of welld's process tree.
//
// Returns once the socket file exists (~150ms first call, instant if
// the master is already up).
export async function ensureSshMaster(opts: {
  name: string;
  ip: string;
  user?: string;
  keyPath: string;
}): Promise<void> {
  const sock = sshControlSocket(opts.name);
  if (existsSync(sock)) return;

  const args = [
    "-fN",
    "-o", "ControlMaster=yes",
    "-o", `ControlPath=${sock}`,
    "-o", `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-i", opts.keyPath,
    `${opts.user ?? "root"}@${opts.ip}`,
  ];
  // Use node:child_process (NOT Bun.spawn) — Bun's spawn tears down
  // children when the spawned process exits, which kills the
  // backgrounded master immediately. `detached: true` + `unref()` lets
  // the master survive. Verified empirically.
  const proc = cpSpawn("ssh", args, {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  proc.unref();
  await new Promise<void>((resolve) => proc.on("close", () => resolve()));

  // The master forks itself. By the time `ssh -fN` exits, the master
  // *should* have created the socket — but there's a tiny race in
  // practice. Poll for up to 2s.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (existsSync(sock)) return;
    await Bun.sleep(50);
  }
  // Master spawn failed silently (auth issue, network down, etc.). Not
  // fatal — exec calls fall back to plain ssh, just slow. Caller logs.
}

// Close the open control master. `ssh -O exit` asks the master to
// gracefully shut down. If there's no master, no-op.
export async function closeSshControl(opts: {
  name: string;
  ip?: string | null;
  user?: string;
  keyPath?: string;
}): Promise<void> {
  const sock = sshControlSocket(opts.name);
  if (!existsSync(sock)) return;

  if (opts.ip && opts.keyPath) {
    const proc = spawn(
      [
        "ssh",
        "-o", `ControlPath=${sock}`,
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-i", opts.keyPath,
        "-O", "exit",
        `${opts.user ?? "root"}@${opts.ip}`,
      ],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    await proc.exited;
  }

  // Belt-and-suspenders: if `ssh -O exit` didn't remove it (e.g., the
  // master had already exited but left the socket), unlink directly.
  if (existsSync(sock)) {
    await unlink(sock).catch(() => {});
  }
}
