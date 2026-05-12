// Sweep dangling `lume run <name>` subprocesses. When lume serve
// crashes, the welld-spawned `lume run` subprocess for each well
// (which is welld's child, not lume serve's) survives the supervisor
// respawn. Most are legitimate — those wells are still alive. But
// when a well is destroyed, the run subprocess for that well should
// die as part of the destroy flow; if lume serve crashed mid-destroy,
// it can be left behind and accumulate over time. Visible via
// `ps aux | grep "lume run"` after a stress run.
//
// We GC by name: walk the ps output for "lume run <name>" entries,
// cross-reference welld's registry, and kill any process whose
// associated name is no longer registered. The registry is the source
// of truth — if the well doesn't exist there, neither should the
// subprocess.

import { spawn } from "bun";
import { listWells } from "./registry.ts";
import { log } from "./log.ts";

// Exported for testability — parser is pure.
export interface LumeRunProcess {
  pid: number;
  name: string;
}

export function parseLumeRunProcesses(psOutput: string): LumeRunProcess[] {
  // Match the upstream lume.app or our hot-built bin/lume; both reach
  // here as "/path/lume run <name>". We anchor on " run " so we don't
  // accidentally match "lume serve" or "lume info".
  const re = /^\s*(\d+)\s+.*\/lume\s+run\s+(\S+)/;
  const out: LumeRunProcess[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.match(re);
    if (!m) continue;
    out.push({ pid: parseInt(m[1]!, 10), name: m[2]! });
  }
  return out;
}

async function listLumeRunProcesses(): Promise<LumeRunProcess[]> {
  const proc = spawn(["ps", "-A", "-o", "pid=,command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return parseLumeRunProcesses(text);
}

// Kill any `lume run <name>` whose name is not in the registry.
// Returns the count killed. Safe to call concurrently with create —
// the registry is consulted under the same lock the create flow uses,
// so a well mid-creation will be present before its lume run starts.
export async function sweepDanglingLumeRun(): Promise<number> {
  const candidates = await listLumeRunProcesses();
  if (candidates.length === 0) return 0;

  const wells = await listWells();
  const known = new Set(wells.map((w) => w.name));

  let killed = 0;
  for (const c of candidates) {
    if (known.has(c.name)) continue;
    try {
      process.kill(c.pid, "SIGTERM");
      log.warn("gc: killed dangling lume run", { pid: c.pid, name: c.name });
      killed++;
    } catch (err) {
      // ESRCH = process already gone (race with another GC run or
      // natural exit). Anything else is worth a log line.
      const msg = (err as Error).message;
      if (!msg.includes("ESRCH") && !msg.includes("No such process")) {
        log.warn("gc: failed to kill dangling lume run", {
          pid: c.pid,
          name: c.name,
          err: msg,
        });
      }
    }
  }
  return killed;
}
