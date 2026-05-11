// Count host processes that are Apple VZ XPC children of a lume-run VM.
// Compared against lume.vm_count by /healthz callers to detect XPC orphans
// from a crashed lume serve. Mirrors the filter in
// engine/vwell-src/src/Virtualization/XPCChildLocator.swift.
//
// Split into:
//   - `parseVzXpcLines(psOutput)` — pure: counts matching lines.
//   - `countVzXpcProcesses()` — shells to `ps -A -o pid=,command=` and feeds
//     the output through the parser.

import { spawn } from "bun";

// VZ XPC service binary identifier. Apple launches each VM's
// `VirtualMachine.xpc` as a launchd-spawned subprocess; the command-line
// always contains this substring.
const VZ_XPC_MARKER = "Virtualization.VirtualMachine";

export function parseVzXpcLines(psOutput: string): number {
  let count = 0;
  for (const line of psOutput.split("\n")) {
    if (line.includes(VZ_XPC_MARKER)) count += 1;
  }
  return count;
}

export async function countVzXpcProcesses(): Promise<number> {
  const proc = spawn(["ps", "-A", "-o", "pid=,command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return parseVzXpcLines(text);
}
