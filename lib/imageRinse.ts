// Identity rinse — clear hostname, machine-id, ssh host keys, and
// cloud-init semaphores from a running well so the next clone of its
// disk boots clean. Used by `well image save --clean` (or POST
// /v1/wells/images with `clean: true`) to produce directly-forkable
// images without the cells team having to script the rinse themselves.
//
// Why not just clonefile the disk and rely on cloud-init? Because the
// source's identity (hostname, machine-id, ssh host keys) is on the
// disk. A clone DHCPs as the source's hostname until cloud-init
// rewrites it, and welld's lease lookup is by hostname — so welld
// never finds the new well. See docs/cells-integration.md "Identity-
// rinse contract" for the full story.

import { spawn } from "bun";
import { PATHS } from "./state.ts";

// One concatenated shell pipeline. Runs as the well user via sudo.
// Ordered: machine-id first (cheapest), then ssh host keys, then
// cloud-init state, then hostname last. Each line is best-effort —
// failures don't poison the rinse since we're about to discard the
// disk's "live" identity anyway.
export const RINSE_SCRIPT = [
  "set -e",
  "sudo rm -f /etc/machine-id /var/lib/dbus/machine-id",
  "sudo rm -f /etc/ssh/ssh_host_*",
  "sudo rm -rf /var/lib/cloud/instances/*",
  "sudo rm -f /etc/.well-ready",
  "sudo truncate -s 0 /etc/hostname",
].join(" && ");

export interface RinseResult {
  ok: boolean;
  exitCode: number;
  stderr: string;
}

// Pure(-ish) — exposed for the daemon. Caller's responsibility to
// ensureRunning the well first. Returns the exit code + stderr; doesn't
// throw on rinse failure (caller decides what to do).
export async function rinseWell(opts: {
  name: string;
  ip: string;
  user?: string;
}): Promise<RinseResult> {
  const user = opts.user ?? "well";
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      "-o", "LogLevel=ERROR",
      "-i", PATHS.vmSshKey(opts.name),
      `${user}@${opts.ip}`,
      RINSE_SCRIPT,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, exitCode, stderr };
}
