// macOS APFS clonefile wrapper. `cp -c` is the documented user-space shim
// for clonefile(2) — sub-millisecond, copy-on-write, blocks shared between
// src and dst until either diverges. Used for: bake disk-swap, splite create
// (clone base into per-splite bundle), checkpoint create.

import { spawn } from "bun";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";

export async function clonefile(src: string, dst: string): Promise<void> {
  if (existsSync(dst)) {
    await unlink(dst);
  }
  const proc = spawn(["cp", "-c", src, dst], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`cp -c ${src} ${dst} failed (exit ${code}): ${err}`);
  }
}
