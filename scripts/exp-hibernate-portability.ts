#!/usr/bin/env bun
// Wells capability probe: is hibernate.bin portable across VM bundles?
//
// The question is wells-side infrastructure: when a saved-state file is
// produced from VM A, can Apple's VZ.framework `restoreMachineStateFrom`
// re-attach it into VM B with a different bundle (different MAC, different
// disk inode, etc)? The answer determines what image-fork primitives wells
// can expose — not how downstream callers compose them.
//
//   - Portable across distinct bundles → wells can offer "fork from saved
//     state": one hibernate.bin shared by N forked instances.
//   - Bundle-pinned → forks must each carry their own hibernate.bin, and
//     wells's image abstraction stays disk-only + warm-restart per fork.
//
// Variants tried in order, until one succeeds (or all fail):
//   v1. Naive: copy hibernate.bin from src to cln, wake cln. VZ may reject
//       because cln has different MAC + different machineIdentifier.
//   v2. Match machineIdentifier: copy src's config.json's machineIdentifier
//       into cln's config.json. Re-create the VM at lume level so VZ picks it up.
//   v3. Match nvram.bin: copy src's nvram.bin (UEFI variables incl. MAC) too.
//   v4. Full bundle clone: cln becomes a byte-for-byte clone of src's bundle
//       except for disk.img path. Tests whether VZ keys to disk inode.
//
// Usage: bun run scripts/exp-hibernate-portability.ts
// Runs against DEV welld at 127.0.0.1:7879. Cleans up wells on exit
// (best effort).

import { homedir } from "node:os";
import { readFile, copyFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";

const BASE = "http://127.0.0.1:7879";
const STATE = join(homedir(), ".wells-dev");
// Lume's bundle root — different from welld's. Lume owns config.json /
// nvram.bin / disk.img / sessions.json under ~/.lume/<name>/. Welld owns
// hibernate.bin / cidata.iso / ssh keys / runtime.json under STATE.
const LUME_BUNDLE_ROOT = join(homedir(), ".lume");
const LUME = "http://127.0.0.1:7780";

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

async function readJson<T = any>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf-8")) as T;
}

interface WellInfo { name: string; ip: string; uuid: string; }

async function createWell(name: string, token: string): Promise<WellInfo> {
  const r = await api<any>("POST", "/v1/wells", { name }, BASE, token);
  return { name: r.name, ip: r.ip, uuid: r.uuid };
}

async function destroyWell(name: string, token: string): Promise<void> {
  await api("DELETE", `/v1/wells/${name}`, undefined, BASE, token).catch(() => {});
}

async function hibernate(name: string, token: string): Promise<number> {
  const t0 = Date.now();
  await api("POST", `/v1/wells/${name}/hibernate`, undefined, BASE, token);
  return Date.now() - t0;
}

// Direct lume call — skips welld's restore recipe validation. We want
// to see what Apple's VZ.framework actually accepts/rejects.
async function lumeRestoreState(name: string, path: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${LUME}/lume/vms/${encodeURIComponent(name)}/restore-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `${res.status}: ${await res.text()}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function lumeStop(name: string): Promise<void> {
  await fetch(`${LUME}/lume/vms/${encodeURIComponent(name)}/stop`, { method: "POST" }).catch(() => {});
}

async function lumeStatus(name: string): Promise<string | null> {
  try {
    const r = await fetch(`${LUME}/lume/vms/${encodeURIComponent(name)}`);
    if (!r.ok) return null;
    return ((await r.json()) as any).status ?? null;
  } catch {
    return null;
  }
}

async function waitFor(name: string, target: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await lumeStatus(name);
    if (s === target) return true;
    await Bun.sleep(500);
  }
  return false;
}

interface Variant {
  name: string;
  // srcLume / clnLume are paths under ~/.lume — that's where Apple's VZ
  // config (config.json, nvram.bin, disk.img) lives. Welld's bundle dir
  // (~/.wells-dev/vms/<n>/) holds welld-managed artifacts only.
  mutateBundle: (srcLume: string, clnLume: string) => Promise<void>;
}

const variants: Variant[] = [
  {
    name: "v1-naive",
    mutateBundle: async () => {
      // No mutation. Just copy hibernate.bin and try to wake.
    },
  },
  {
    name: "v2-match-machineId",
    mutateBundle: async (srcLume, clnLume) => {
      const srcCfg = await readJson(join(srcLume, "config.json"));
      const clnCfg = await readJson(join(clnLume, "config.json"));
      if (srcCfg.machineIdentifier) {
        clnCfg.machineIdentifier = srcCfg.machineIdentifier;
        await Bun.write(join(clnLume, "config.json"), JSON.stringify(clnCfg, null, 2));
      }
    },
  },
  {
    name: "v3-match-machineId-and-nvram",
    mutateBundle: async (srcLume, clnLume) => {
      const srcCfg = await readJson(join(srcLume, "config.json"));
      const clnCfg = await readJson(join(clnLume, "config.json"));
      if (srcCfg.machineIdentifier) {
        clnCfg.machineIdentifier = srcCfg.machineIdentifier;
        await Bun.write(join(clnLume, "config.json"), JSON.stringify(clnCfg, null, 2));
      }
      if (await exists(join(srcLume, "nvram.bin"))) {
        await copyFile(join(srcLume, "nvram.bin"), join(clnLume, "nvram.bin"));
      }
    },
  },
  {
    name: "v4-full-bundle-mirror",
    mutateBundle: async (srcLume, clnLume) => {
      // Full mirror except disk.img stays cln's own. nvram + machineId + MAC + memory + cpu all match src.
      const srcCfg = await readJson(join(srcLume, "config.json"));
      const clnCfg = await readJson(join(clnLume, "config.json"));
      const fields = ["machineIdentifier", "macAddress", "memorySize", "cpuCount", "os", "arch"] as const;
      for (const f of fields) if (srcCfg[f] !== undefined) clnCfg[f] = srcCfg[f];
      await Bun.write(join(clnLume, "config.json"), JSON.stringify(clnCfg, null, 2));
      if (await exists(join(srcLume, "nvram.bin"))) {
        await copyFile(join(srcLume, "nvram.bin"), join(clnLume, "nvram.bin"));
      }
    },
  },
];

async function main(): Promise<void> {
  const token = await readToken();
  const stamp = Date.now().toString(36);
  const srcName = `egg-src-${stamp}`;
  const clnNamePrefix = `egg-cln-${stamp}`;
  const findings: Array<{ variant: string; ok: boolean; detail: string }> = [];

  console.log(`Multi-hatch experiment starting (stamp=${stamp})`);

  // --- Phase A: prepare source egg ---
  console.log(`\n[A] Create source egg ${srcName}...`);
  const src = await createWell(srcName, token);
  console.log(`  IP=${src.ip}, UUID=${src.uuid}`);

  console.log(`[A] Hibernate ${srcName}...`);
  const hibMs = await hibernate(srcName, token);
  console.log(`  hibernated in ${hibMs}ms`);

  const srcLume = join(LUME_BUNDLE_ROOT, srcName);
  const srcHib = join(STATE, "vms", srcName, "hibernate.bin");
  if (!(await exists(srcHib))) throw new Error("source hibernate.bin missing");
  console.log(`  hibernate.bin exists at ${srcHib}`);

  // --- Phase B: try each variant ---
  const orphanCln: string[] = [];
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]!;
    const clnName = `${clnNamePrefix}-${v.name}`.slice(0, 31); // bundle name length cap
    console.log(`\n[B${i + 1}] Variant ${v.name} → clone ${clnName}`);

    let cln: WellInfo | null = null;
    let createSucceeded = false;
    try {
      try {
        cln = await createWell(clnName, token);
        createSucceeded = true;
        console.log(`  cln IP=${cln.ip}, UUID=${cln.uuid}`);
      } catch (e) {
        // welld create may time out on hostname-search even when lume
        // has the VM running. Continue with the clean-stop dance —
        // lume itself can still see the bundle.
        console.log(`  ! welld create timed out (${(e as Error).message.slice(0, 80)}…)`);
        console.log(`  attempting to proceed via lume directly`);
        orphanCln.push(clnName);
      }

      const clnLume = join(LUME_BUNDLE_ROOT, clnName);
      const clnHib = join(STATE, "vms", clnName, "hibernate.bin");
      const clnHibLume = join(clnLume, "hibernate.bin");

      // Stop cln cleanly so its disk is released for VZ to reattach during restore.
      console.log(`  stopping cln (lume)...`);
      await lumeStop(clnName);
      const stopped = await waitFor(clnName, "stopped", 30_000);
      if (!stopped) throw new Error("cln did not stop");

      // Mutate cln's lume bundle per variant.
      console.log(`  mutating bundle...`);
      await v.mutateBundle(srcLume, clnLume);

      // Copy src's hibernate.bin into cln's lume bundle (lume.restoreState
      // path is server-side absolute; place it adjacent to disk.img).
      console.log(`  copying hibernate.bin: src → cln`);
      await copyFile(srcHib, clnHibLume);
      // Also copy to welld's bundle path if welld registered the well —
      // keeps state-dir consistent for later cleanup.
      if (createSucceeded) {
        await copyFile(srcHib, clnHib).catch(() => {});
      }

      // Try the restore via lume directly (bypasses welld validation).
      console.log(`  lume.restoreState(${clnName})...`);
      const r = await lumeRestoreState(clnName, clnHibLume);

      if (r.ok) {
        console.log(`  ✓ RESTORE ACCEPTED for ${v.name}`);
        // Quick sanity: status running?
        const st = await lumeStatus(clnName);
        const detail = `restore ok; status=${st ?? "?"}`;
        findings.push({ variant: v.name, ok: true, detail });

        // Stop cln before next variant (preserves src's hibernate)
        await lumeStop(clnName);
        await waitFor(clnName, "stopped", 15_000);
      } else {
        console.log(`  ✗ ${v.name} REJECTED: ${r.error}`);
        findings.push({ variant: v.name, ok: false, detail: r.error ?? "unknown" });
      }
    } catch (e) {
      console.log(`  ! ${v.name} threw: ${(e as Error).message}`);
      findings.push({ variant: v.name, ok: false, detail: `threw: ${(e as Error).message}` });
    } finally {
      if (cln) await destroyWell(cln.name, token);
    }
  }

  // Best-effort cleanup of any cln bundles welld didn't track.
  for (const name of orphanCln) {
    await fetch(`${LUME}/lume/vms/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => {});
    await rm(join(STATE, "vms", name), { recursive: true, force: true }).catch(() => {});
  }

  // --- Phase C: cleanup source ---
  console.log(`\n[C] Cleanup source...`);
  await destroyWell(srcName, token);

  // --- Summary ---
  console.log(`\n=========================`);
  console.log(`MULTI-HATCH RESULTS`);
  console.log(`=========================`);
  for (const f of findings) {
    const mark = f.ok ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${f.variant.padEnd(28)} ${f.detail}`);
  }
  const anyOk = findings.some((f) => f.ok);
  console.log();
  console.log(anyOk
    ? "VERDICT: hibernate.bin is portable. Wells can offer 'fork from saved state' as an image-level primitive."
    : "VERDICT: hibernate.bin is bundle-pinned. Forks must carry their own hibernate.bin; image abstraction stays disk-only + warm-restart per fork.");
}

await main();
