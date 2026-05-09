// Doctor — one-shot health diagnostic. Hits welld + lume directly,
// scans for orphan lume run subprocesses, lists wells. Read-only;
// safe to run during a live birth flow.
//
// Pure-ish module: gatherDoctorReport() does I/O; renderDoctorText() and
// doctorExitCode() are pure for testing.

import { spawn } from "bun";
import { humanAge } from "./humanAge.ts";

export interface DoctorReport {
  result: "healthy" | "degraded" | "unhealthy";
  welld:
    | { reachable: false; error: string }
    | {
        reachable: true;
        version: string;
        uptime: string;
        degraded: boolean;
        lume_owned: boolean;
        respawns: { last_1min: number; last_5min: number; last_hour: number };
      };
  lume:
    | { reachable: false; error: string }
    | { reachable: true; status: string; vm_count: number; max_vms: number };
  orphans: { pid: number; name: string }[];
  // VZ XPC children: one process per running VM, launched by launchd
  // (PPID=1) when lume calls Virtualization.framework. Mismatch with
  // lume.vm_count = orphan from a crashed/respawned lume serve that
  // lost its SharedVM cache. See B.0.6 + B.0.7.f.
  xpc_children: { pid: number }[];
  wells:
    | { listed: false; error: string }
    | {
        listed: true;
        entries: { name: string; status: string; ip: string | null }[];
      };
}

export interface DoctorDeps {
  // Inject for tests. Defaults call real network + ps.
  fetchHealthz: () => Promise<{ ok: boolean; status: number; body?: unknown }>;
  fetchLume: () => Promise<{ ok: boolean; status: number; body?: unknown }>;
  fetchWells: () => Promise<{ name: string; status: string; ip?: string | null }[]>;
  scanOrphans: () => Promise<{ pid: number; name: string }[]>;
  // Walk the host process table for `Virtualization.VirtualMachine`
  // exec markers — Apple's VZ XPC service. One per running VM.
  scanXpcChildren: () => Promise<{ pid: number }[]>;
}

export async function gatherDoctorReport(
  deps: DoctorDeps,
): Promise<DoctorReport> {
  let healthOk = true;
  let degraded = false;

  let welld: DoctorReport["welld"];
  try {
    const r = await deps.fetchHealthz();
    if (!r.ok) {
      welld = { reachable: false, error: `HTTP ${r.status}` };
      healthOk = false;
    } else {
      const body = r.body as {
        version: string;
        started_at: string;
        lume?: {
          owned?: boolean;
          respawns_last_hour?: number;
          respawns_last_5min?: number;
          respawns_last_1min?: number;
        };
        degraded?: boolean;
      };
      welld = {
        reachable: true,
        version: body.version,
        uptime: humanAge(body.started_at),
        degraded: body.degraded === true,
        lume_owned: body.lume?.owned === true,
        respawns: {
          last_1min: body.lume?.respawns_last_1min ?? 0,
          last_5min: body.lume?.respawns_last_5min ?? 0,
          last_hour: body.lume?.respawns_last_hour ?? 0,
        },
      };
      degraded = welld.degraded;
    }
  } catch (e) {
    welld = { reachable: false, error: (e as Error).message };
    healthOk = false;
  }

  let lume: DoctorReport["lume"];
  try {
    const r = await deps.fetchLume();
    if (r.ok) {
      const body = r.body as { status?: string; vm_count?: number; max_vms?: number };
      lume = {
        reachable: true,
        status: body.status ?? "?",
        vm_count: body.vm_count ?? 0,
        max_vms: body.max_vms ?? 0,
      };
    } else {
      lume = { reachable: false, error: `HTTP ${r.status}` };
      healthOk = false;
    }
  } catch (e) {
    lume = { reachable: false, error: (e as Error).message };
    healthOk = false;
  }

  const orphans = await deps.scanOrphans();
  const xpcChildren = await deps.scanXpcChildren();

  // VZ XPC orphan check: lume reports N VMs, but the host has M
  // VirtualMachine.xpc processes alive. M > N = orphans (lume lost
  // SharedVM cache). M < N is unusual but theoretically possible
  // mid-shutdown — we report it but don't degrade.
  if (lume.reachable && xpcChildren.length > lume.vm_count) {
    degraded = true;
  }

  let wells: DoctorReport["wells"];
  try {
    const entries = await deps.fetchWells();
    wells = {
      listed: true,
      entries: entries.map((w) => ({
        name: w.name,
        status: w.status,
        ip: w.ip ?? null,
      })),
    };
  } catch (e) {
    wells = { listed: false, error: (e as Error).message };
    healthOk = false;
  }

  const result: DoctorReport["result"] =
    !healthOk ? "unhealthy" : degraded ? "degraded" : "healthy";
  return { result, welld, lume, orphans, xpc_children: xpcChildren, wells };
}

export function renderDoctorText(r: DoctorReport): string {
  const out: string[] = [];
  out.push("=== welld ===");
  if (!r.welld.reachable) {
    out.push(`  unreachable: ${r.welld.error}`);
  } else {
    out.push(`  version:      ${r.welld.version}`);
    out.push(`  uptime:       ${r.welld.uptime}`);
    out.push(`  degraded:     ${r.welld.degraded ? "YES" : "no"}`);
    out.push(`  lume owned:   ${r.welld.lume_owned ? "yes (welld supervises)" : "no (external)"}`);
    out.push(`  lume respawns 1m/5m/1h: ${r.welld.respawns.last_1min}/${r.welld.respawns.last_5min}/${r.welld.respawns.last_hour}`);
  }
  out.push("");
  out.push("=== lume serve ===");
  if (!r.lume.reachable) {
    out.push(`  unreachable: ${r.lume.error}`);
  } else {
    out.push(`  status:   ${r.lume.status}`);
    out.push(`  VMs:      ${r.lume.vm_count} / ${r.lume.max_vms} max`);
  }
  out.push("");
  out.push("=== orphaned lume run subprocesses ===");
  if (r.orphans.length === 0) {
    out.push("  (none)");
  } else {
    for (const o of r.orphans) out.push(`  pid ${o.pid} → ${o.name}`);
  }
  out.push("");
  out.push("=== VZ XPC children (Virtualization.VirtualMachine procs) ===");
  if (r.lume.reachable) {
    const lumeCount = r.lume.vm_count;
    const xpcCount = r.xpc_children.length;
    out.push(`  count: ${xpcCount} (lume reports ${lumeCount} VMs)`);
    if (xpcCount > lumeCount) {
      out.push(`  ORPHAN: ${xpcCount - lumeCount} XPC child(ren) without a lume VM — likely from a crashed lume serve`);
      for (const c of r.xpc_children) out.push(`    pid ${c.pid}`);
    } else if (xpcCount < lumeCount) {
      out.push(`  WARNING: lume claims more VMs than VZ children alive — VM may be mid-shutdown`);
    }
  } else {
    out.push(`  count: ${r.xpc_children.length} (lume unreachable, no comparison)`);
  }
  out.push("");
  out.push("=== wells ===");
  if (!r.wells.listed) {
    out.push(`  failed to list: ${r.wells.error}`);
  } else if (r.wells.entries.length === 0) {
    out.push("  (no wells)");
  } else {
    for (const w of r.wells.entries) {
      out.push(`  ${w.name.padEnd(15)} ${w.status.padEnd(10)} ${w.ip ?? "—"}`);
    }
  }
  out.push("");
  out.push(`RESULT: wells is ${r.result.toUpperCase()}${
    r.result === "degraded" ? " (high respawn rate) — operational but fragile" :
    r.result === "unhealthy" ? " — see above" : ""
  }`);
  return out.join("\n");
}

export function doctorExitCode(result: DoctorReport["result"]): number {
  if (result === "unhealthy") return 1;
  if (result === "degraded") return 2;
  return 0;
}

// Real-world dependency adapters used by the CLI. Out of band from the
// pure functions above so unit tests can avoid network + ps.
export function defaultDoctorDeps(
  apiBaseUrl: string,
  fetchWellsList: () => Promise<{ name: string; status: string; ip?: string | null }[]>,
): DoctorDeps {
  return {
    fetchHealthz: async () => {
      const r = await fetch(apiBaseUrl + "/healthz", {
        signal: AbortSignal.timeout(3000),
      });
      const body = r.ok ? await r.json() : undefined;
      return { ok: r.ok, status: r.status, body };
    },
    fetchLume: async () => {
      const r = await fetch("http://127.0.0.1:7777/lume/host/status", {
        signal: AbortSignal.timeout(3000),
      });
      const body = r.ok ? await r.json() : undefined;
      return { ok: r.ok, status: r.status, body };
    },
    fetchWells: fetchWellsList,
    scanOrphans: async () => {
      const proc = spawn(["ps", "-A", "-o", "pid=,command="], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      const orphans: { pid: number; name: string }[] = [];
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*(\d+)\s+.*\/lume\s+run\s+(\S+)/);
        if (m) orphans.push({ pid: parseInt(m[1]!, 10), name: m[2]! });
      }
      return orphans;
    },
    scanXpcChildren: async () => {
      // Mirror lume's XPCChildLocator filter: any executable path
      // containing "Virtualization.VirtualMachine" (Apple's XPC
      // service for the VZ framework).
      const proc = spawn(["ps", "-A", "-o", "pid=,command="], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      const children: { pid: number }[] = [];
      for (const line of text.split("\n")) {
        if (!line.includes("Virtualization.VirtualMachine")) continue;
        const m = line.match(/^\s*(\d+)\s+/);
        if (m) children.push({ pid: parseInt(m[1]!, 10) });
      }
      return children;
    },
  };
}
