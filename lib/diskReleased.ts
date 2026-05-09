// Wait for a bundle disk to be fully released by the VZ process.
// Used after SSH-shutdown of a guest, before clonefile or restart.
// `lume.info` reports `stopped` faster than VZ actually drops the
// disk handle; lsof is the authoritative signal.

import { spawn } from "bun";

export async function waitForDiskReleased(
  diskPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const proc = spawn(["lsof", diskPath], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    if (out.trim().length === 0) return;
    await Bun.sleep(500);
  }
  throw new Error(`disk ${diskPath} still held within ${timeoutMs}ms`);
}
