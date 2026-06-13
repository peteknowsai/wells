// Wait for a bundle disk to be fully released by the VZ process.
// Used after a guest halt (sysrq / lume.stop), before clonefile or
// restart. `lume.info` reports `stopped` faster than VZ actually drops
// the disk handle; lsof is the authoritative signal.
//
// Poll interval is 100ms because the guest-side halt that precedes
// this wait is typically <500ms (sysrq-trigger poweroff). At 500ms
// polling we wasted up to 500ms of cycle time per create.

import { spawn } from "bun";

// One lsof check: true if nothing holds the path open right now.
export async function isDiskReleased(diskPath: string): Promise<boolean> {
  const proc = spawn(["lsof", diskPath], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim().length === 0;
}

// Poll until the disk is free or the deadline passes. Returns whether it
// was released — never throws. Callers that branch on the outcome (e.g.
// the seal fast-path that escalates to a host-controlled stop on a stall)
// use this; callers that want a hard failure use waitForDiskReleased.
export async function diskReleasedWithin(
  diskPath: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Check at least once even if timeoutMs is 0.
  do {
    if (await isDiskReleased(diskPath)) return true;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  return false;
}

export async function waitForDiskReleased(
  diskPath: string,
  timeoutMs: number,
): Promise<void> {
  if (!(await diskReleasedWithin(diskPath, timeoutMs))) {
    throw new Error(`disk ${diskPath} still held within ${timeoutMs}ms`);
  }
}
