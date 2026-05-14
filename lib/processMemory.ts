// Read resident set size (RSS) for host processes. Used by the dashboard
// to report how much physical RAM each running well's VZ XPC child is
// actually holding on the Mac — RSS reflects the resident (physically-
// backed) footprint, so an idle well that hasn't faulted in its full
// guest RAM honestly reads lower than a busy one.

import { spawn } from "bun";

// Pure: parse `ps -A -o pid=,rss=` output into a pid→bytes map. macOS
// `ps` reports rss in 1024-byte units. Lines that aren't exactly two
// integer columns are skipped — `ps` output is well-formed, but defensive
// parsing keeps a stray header or blank line from poisoning the map.
export function parseRssOutput(output: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const rssKb = Number(m[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(rssKb)) continue;
    out.set(pid, rssKb * 1024);
  }
  return out;
}

// Shell to `ps` and return a pid→resident-bytes map for every process.
// Returns an empty map if `ps` fails — callers degrade to null per pid.
export async function residentBytesByPid(): Promise<Map<number, number>> {
  try {
    const proc = spawn(["ps", "-A", "-o", "pid=,rss="], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return parseRssOutput(text);
  } catch {
    return new Map();
  }
}
