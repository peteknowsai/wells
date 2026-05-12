#!/usr/bin/env bun
// Phase 2 of the thaw experiment. Phase 1
// (scripts/exp-hibernate-portability.ts) established that VZ accepts
// `restoreMachineStateFrom` only when the cln bundle is a full mirror
// of the src bundle (v4 variant). This script tests the bigger
// question Pete raised: can src AND multiple clns all thaw from the
// same hibernate.bin and run concurrently with independent IPs / PIDs?
//
// "Thaw" is wells's verb for "given one hibernated bundle, materialize
// N running VMs from it." Single-thaw = normal `well wake`.
// Multi-thaw = the new primitive this experiment scopes.
//
// Risk surfaces (docs/findings-thaw.md):
//   - all clns inherit src's MAC (from src's nvram.bin) → vmnet may
//     refuse / collide on DHCP lease
//   - all clns inherit src's machineIdentifier → VZ may dedupe
//   - all clns inherit src's hostname → DNS / mDNS collisions
//
// Approach:
//   1. Create + warm + hibernate src.
//   2. For N in {1, 2}: clone src bundle → cln_N (v4 mirror). Each
//      cln gets the SAME nvram.bin (= same MAC) as src for now.
//   3. Thaw src (welld API) AND each cln (direct lume) via Promise.all.
//      Capture per-VM: IP, lume PID, status, ssh ping (best effort).
//   4. Report whether all N+1 wells hold distinct IPs, whether any
//      lume serve respawn was triggered, whether vmnet dropped the
//      MAC-collision wells.
//
// Usage: bun run scripts/exp-thaw-concurrent.ts
// Runs against DEV welld at 127.0.0.1:7879. Cleans up wells on exit
// (best effort).

import { homedir } from "node:os";
import { readFile, copyFile, stat, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";

const BASE = "http://127.0.0.1:7879";
const STATE = join(homedir(), ".wells-dev");
const LUME_BUNDLE_ROOT = join(homedir(), ".lume");
const LUME = "http://127.0.0.1:7780";
const N_CLONES = Number(process.env.THAW_N_CLONES ?? 2);  // src + N concurrent thaws (env-overridable for bisecting the threshold)

async function readToken(): Promise<string> {
  return (await readFile(join(STATE, "token"), "utf-8")).trim();
}

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  base = BASE,
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function lumeStop(name: string): Promise<void> {
  await fetch(`${LUME}/lume/vms/${name}/stop`, { method: "POST" }).catch(() => {});
}

async function lumeStatus(name: string): Promise<{ status: string; ipAddress: string | null } | null> {
  const r = await fetch(`${LUME}/lume/vms/${name}`);
  if (!r.ok) return null;
  const j: any = await r.json().catch(() => null);
  if (!j) return null;
  return { status: j.status, ipAddress: j.ipAddress ?? null };
}

async function lumeRestoreState(name: string, hibernatePath: string): Promise<{ ok: boolean; error?: string }> {
  // Mirror the wakeWell shape (engine/vwell.ts:LumeClient#restoreState):
  // POST /lume/vms/<name>/restoreState with {hibernate_path}.
  const r = await fetch(`${LUME}/lume/vms/${name}/restoreState`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hibernate_path: hibernatePath }),
  });
  if (r.ok) return { ok: true };
  const err = await r.text();
  return { ok: false, error: `${r.status}: ${err}` };
}

async function waitFor(name: string, target: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await lumeStatus(name);
    if (s?.status === target) return true;
    await Bun.sleep(500);
  }
  return false;
}

async function copyDirRecursive(src: string, dst: string): Promise<void> {
  const proc = spawn(["cp", "-R", src, dst], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(`cp -R ${src} ${dst} failed: ${err}`);
  }
}

async function lumePidFromHealthz(): Promise<number | null> {
  // Resolve via lsof on the lume serve port. Cheap, no welld dep.
  const proc = spawn(["lsof", "-iTCP:7780", "-sTCP:LISTEN", "-n", "-P"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  for (const line of out.split("\n").slice(1)) {
    const cols = line.split(/\s+/);
    if (cols.length >= 2) {
      const pid = Number(cols[1]);
      if (!Number.isNaN(pid)) return pid;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const stamp = Math.random().toString(36).slice(2, 10);
  const srcName = `thaw-src-${stamp}`;
  const clnNames = Array.from({ length: N_CLONES }, (_, i) => `thaw-cln${i + 1}-${stamp}`);
  const orphans: string[] = [];
  const findings: string[] = [];
  const token = await readToken();

  console.log(`Multi-wake-simultaneous experiment (stamp=${stamp})`);
  console.log(`  N+1 = ${N_CLONES + 1} VMs targeted (src + ${N_CLONES} clones)`);

  try {
    // --- Phase A: src well, warm, hibernate ---
    console.log(`\n[A] Create + warm + hibernate src ${srcName}`);
    const srcCreate: any = await api("POST", "/v1/wells", { name: srcName }, BASE, token);
    console.log(`  src IP=${srcCreate.ip} UUID=${srcCreate.uuid}`);
    await api("POST", `/v1/wells/${srcName}/hibernate`, undefined, BASE, token);
    const srcHib = join(STATE, "vms", srcName, "hibernate.bin");
    if (!(await exists(srcHib))) throw new Error(`src hibernate.bin missing at ${srcHib}`);
    console.log(`  src hibernated; hibernate.bin at ${srcHib}`);

    const srcLume = join(LUME_BUNDLE_ROOT, srcName);

    // --- Phase B: build N v4-mirror cln bundles. Critical: lume needs
    //              the VM registered in its session map BEFORE
    //              restoreState; just `cp -R`'ing into ~/.lume/ doesn't
    //              auto-discover (lume scans on startup only).
    //              So: create cln via welld (which wires up lume),
    //              warm it, stop it, then OVERWRITE the bundle with
    //              src's bundle (v4 mirror) + src's hibernate.bin.
    //              When restoreState fires, lume already knows the name.
    console.log(`\n[B] Build ${N_CLONES} cln bundles as v4-full-bundle-mirror`);
    for (const clnName of clnNames) {
      const clnLume = join(LUME_BUNDLE_ROOT, clnName);
      orphans.push(clnName);
      console.log(`  creating ${clnName} via welld (registers in lume)...`);
      await api("POST", "/v1/wells", { name: clnName }, BASE, token);
      console.log(`  stopping ${clnName} (lume) so disk is released...`);
      await lumeStop(clnName);
      const stopped = await waitFor(clnName, "stopped", 30_000);
      if (!stopped) throw new Error(`${clnName} did not stop`);
      console.log(`  mirroring src bundle → ${clnName} bundle (config.json + nvram.bin + disk.img)...`);
      // v4-full-bundle-mirror: copy src's config.json, nvram.bin, disk.img
      // over cln's. Don't blow away the bundle dir itself (lume's
      // session map points at it); just overwrite the contents.
      await copyFile(join(srcLume, "config.json"), join(clnLume, "config.json"));
      await copyFile(join(srcLume, "nvram.bin"), join(clnLume, "nvram.bin"));
      await copyFile(join(srcLume, "disk.img"), join(clnLume, "disk.img"));
      // hibernate.bin lives in welld state, not lume bundle. Place a
      // copy adjacent to cln's disk.img so lume.restoreState's
      // hibernate_path points at the cln-local copy.
      await copyFile(srcHib, join(clnLume, "hibernate.bin"));
      console.log(`  ${clnName} bundle ready at ${clnLume}`);
    }

    // --- Phase C: simultaneously wake src + all clns ---
    console.log(`\n[C] Simultaneously wake src + ${N_CLONES} clones`);
    const wakeOps: Array<Promise<{ name: string; ms: number; ok: boolean; error?: string }>> = [];
    // src wakes via welld (proper hibernate→running transition).
    wakeOps.push((async () => {
      const t0 = Date.now();
      try {
        await api("POST", `/v1/wells/${srcName}/wake`, undefined, BASE, token);
        return { name: srcName, ms: Date.now() - t0, ok: true };
      } catch (e) {
        return { name: srcName, ms: Date.now() - t0, ok: false, error: (e as Error).message };
      }
    })());
    // clns wake via direct lume.restoreState.
    for (const clnName of clnNames) {
      const clnLumeHib = join(LUME_BUNDLE_ROOT, clnName, "hibernate.bin");
      wakeOps.push((async () => {
        const t0 = Date.now();
        const r = await lumeRestoreState(clnName, clnLumeHib);
        return { name: clnName, ms: Date.now() - t0, ok: r.ok, ...(r.error ? { error: r.error } : {}) };
      })());
    }
    const wakeResults = await Promise.all(wakeOps);
    for (const r of wakeResults) {
      const mark = r.ok ? "✓" : "✗";
      console.log(`  ${mark} ${r.name.padEnd(40)} wake=${r.ms}ms${r.error ? ` (${r.error.slice(0, 80)})` : ""}`);
    }

    // --- Phase D: poll status + IPs ---
    console.log(`\n[D] Poll status + IPs (15s)`);
    await Bun.sleep(2000);
    const statuses: Record<string, { status: string; ipAddress: string | null }> = {};
    for (const name of [srcName, ...clnNames]) {
      const s = await lumeStatus(name);
      statuses[name] = s ?? { status: "?", ipAddress: null };
    }
    // Wait up to 15s for IPs to land (the wakers should already have
    // their pre-hibernate IP, but vmnet may need a tick).
    const deadline = Date.now() + 13_000;
    while (Date.now() < deadline) {
      let anyMissing = false;
      for (const name of [srcName, ...clnNames]) {
        const s = statuses[name];
        if (s?.status === "running" && !s.ipAddress) { anyMissing = true; break; }
      }
      if (!anyMissing) break;
      await Bun.sleep(1000);
      for (const name of [srcName, ...clnNames]) {
        const s = await lumeStatus(name);
        statuses[name] = s ?? { status: "?", ipAddress: null };
      }
    }
    console.log();
    console.log("  Final per-VM status:");
    const ipSet = new Set<string>();
    for (const name of [srcName, ...clnNames]) {
      const s = statuses[name];
      const ipStr = s?.ipAddress ?? "(none)";
      console.log(`    ${name.padEnd(40)} status=${s?.status?.padEnd(8) ?? "?"} ip=${ipStr}`);
      if (s?.ipAddress) ipSet.add(s.ipAddress);
    }

    const lumePid = await lumePidFromHealthz();
    console.log(`\n  lume serve PID: ${lumePid ?? "?"}`);

    // --- Verdict ---
    console.log(`\n=========================`);
    console.log(`SIMULTANEOUS-WAKE RESULTS`);
    console.log(`=========================`);
    const total = N_CLONES + 1;
    const running = [srcName, ...clnNames].filter((n) => statuses[n]?.status === "running").length;
    const distinctIps = ipSet.size;
    console.log(`  ${running}/${total} wells reached status=running`);
    console.log(`  ${distinctIps}/${total} distinct IPs assigned`);
    if (running === total && distinctIps === total) {
      findings.push(`all ${total} VMs running with distinct IPs — concurrent wake works without MAC mutation`);
    } else if (running === total && distinctIps < total) {
      findings.push(`all ${total} VMs running but only ${distinctIps} distinct IPs — vmnet collapsed colliding MACs`);
    } else if (running < total) {
      findings.push(`only ${running}/${total} VMs reached running — VZ rejected one or more concurrent restores`);
    }

    for (const f of findings) console.log(`  • ${f}`);

  } finally {
    // Cleanup: stop all wells, destroy src via welld, lume-delete clns.
    console.log(`\n[E] Cleanup`);
    for (const name of [srcName, ...clnNames]) {
      await lumeStop(name).catch(() => {});
    }
    await Bun.sleep(2000);
    await api("DELETE", `/v1/wells/${srcName}`, undefined, BASE, token).catch(() => {});
    for (const clnName of orphans) {
      await fetch(`${LUME}/lume/vms/${clnName}`, { method: "DELETE" }).catch(() => {});
      await rm(join(LUME_BUNDLE_ROOT, clnName), { recursive: true, force: true }).catch(() => {});
    }
    console.log(`  done`);
  }
}

await main();
