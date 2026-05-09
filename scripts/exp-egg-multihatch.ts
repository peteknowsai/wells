#!/usr/bin/env bun
// Experiment: can the same hibernate.bin be restored into a different VM?
// Determines cells team's pool/eggs architecture:
//   - If yes: one egg, N hatched cells. Massive disk-space win for big cells.
//   - If no: per-pool-member hibernate.bin. Still fast, just N×RAM-snapshot disk.
//
// Variants tried in order, until one succeeds (or all fail):
//   v1. Naive: copy hibernate.bin from src to cln, wake cln. Apple may reject
//       because cln has different MAC + different machineIdentifier.
//   v2. Match machineIdentifier: copy src's config.json's machineIdentifier
//       into cln's config.json. Re-create the VM at lume level so VZ picks it up.
//   v3. Match nvram.bin: copy src's nvram.bin (UEFI variables incl. MAC) too.
//   v4. Full bundle clone: cln becomes a byte-for-byte clone of src's bundle
//       except for disk.img path. Tests whether Apple keys to disk inode.
//
// Usage: bun run scripts/exp-egg-multihatch.ts
// Runs against DEV welld at 127.0.0.1:7879. Requires WELL_BASE_URL_DEV unset
// or set explicitly. Cleans up wells on exit (best effort).

import { homedir } from "node:os";
import { readFile, copyFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";

const BASE = "http://127.0.0.1:7879";
const STATE = join(homedir(), ".wells-dev");
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
  mutateBundle: (srcDir: string, clnDir: string) => Promise<void>;
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
    mutateBundle: async (srcDir, clnDir) => {
      const srcCfg = await readJson(join(srcDir, "config.json"));
      const clnCfg = await readJson(join(clnDir, "config.json"));
      if (srcCfg.machineIdentifier) {
        clnCfg.machineIdentifier = srcCfg.machineIdentifier;
        await Bun.write(join(clnDir, "config.json"), JSON.stringify(clnCfg, null, 2));
      }
    },
  },
  {
    name: "v3-match-machineId-and-nvram",
    mutateBundle: async (srcDir, clnDir) => {
      const srcCfg = await readJson(join(srcDir, "config.json"));
      const clnCfg = await readJson(join(clnDir, "config.json"));
      if (srcCfg.machineIdentifier) {
        clnCfg.machineIdentifier = srcCfg.machineIdentifier;
        await Bun.write(join(clnDir, "config.json"), JSON.stringify(clnCfg, null, 2));
      }
      if (await exists(join(srcDir, "nvram.bin"))) {
        await copyFile(join(srcDir, "nvram.bin"), join(clnDir, "nvram.bin"));
      }
    },
  },
  {
    name: "v4-full-bundle-mirror",
    mutateBundle: async (srcDir, clnDir) => {
      // Full mirror except disk.img stays cln's own. nvram + machineId + MAC + memory + cpu all match src.
      const srcCfg = await readJson(join(srcDir, "config.json"));
      const clnCfg = await readJson(join(clnDir, "config.json"));
      const fields = ["machineIdentifier", "macAddress", "memorySize", "cpuCount", "os", "arch"] as const;
      for (const f of fields) if (srcCfg[f] !== undefined) clnCfg[f] = srcCfg[f];
      await Bun.write(join(clnDir, "config.json"), JSON.stringify(clnCfg, null, 2));
      if (await exists(join(srcDir, "nvram.bin"))) {
        await copyFile(join(srcDir, "nvram.bin"), join(clnDir, "nvram.bin"));
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

  const srcDir = join(STATE, "vms", srcName);
  const srcHib = join(srcDir, "hibernate.bin");
  if (!(await exists(srcHib))) throw new Error("source hibernate.bin missing");
  console.log(`  hibernate.bin exists at ${srcHib}`);

  // --- Phase B: try each variant ---
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]!;
    const clnName = `${clnNamePrefix}-${v.name}`.slice(0, 31); // bundle name length cap
    console.log(`\n[B${i + 1}] Variant ${v.name} → clone ${clnName}`);

    let cln: WellInfo | null = null;
    try {
      cln = await createWell(clnName, token);
      console.log(`  cln IP=${cln.ip}, UUID=${cln.uuid}`);

      const clnDir = join(STATE, "vms", clnName);

      // Stop cln cleanly so its disk is released for VZ to reattach during restore.
      console.log(`  stopping cln (welld)...`);
      await api("POST", `/v1/wells/${clnName}/stop`, undefined, BASE, token);
      const stopped = await waitFor(clnName, "stopped", 30_000);
      if (!stopped) throw new Error("cln did not stop");

      // Mutate cln's bundle per variant.
      console.log(`  mutating bundle...`);
      await v.mutateBundle(srcDir, clnDir);

      // Copy src's hibernate.bin to cln's path.
      const clnHib = join(clnDir, "hibernate.bin");
      console.log(`  copying hibernate.bin: src → cln`);
      await copyFile(srcHib, clnHib);

      // Try the restore via lume directly (bypasses welld validation).
      console.log(`  lume.restoreState(${clnName})...`);
      const r = await lumeRestoreState(clnName, clnHib);

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
    ? "VERDICT: at least one variant works. Cells team has a green light for shared eggs."
    : "VERDICT: no variant accepted by Apple VZ. Cells team should plan for per-pool-member snapshots.");
}

await main();
