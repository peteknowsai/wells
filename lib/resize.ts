// Memory resize for existing wells (cells production-readiness ask #4,
// 2026-06-10 — mother's supervisor OOM-killed at the 1GB default).
//
// VZ.framework pins memorySize at boot: there is no live grow path
// (the balloon device can only reclaim, never exceed the boot
// allocation). What we CAN do cheaply: rewrite `memorySize` in the
// lume bundle's config.json while the VM is down — VM.swift reads it
// on every start — so a resize is stop → PATCH → start, seconds of
// downtime, disk and identity preserved. Strictly better than the
// re-create cells thought they needed.
//
// Refusals:
// - alive_* (or lume says running): VZ can't resize a live VM. Stop it
//   first. We refuse rather than auto-stop — wells never yanks a
//   running guest out from under the operator (activity-detection
//   principle).
// - hibernating: the hibernate restore recipe pins memorySizeBytes
//   (VZConfigSnapshot drift check); changing memory under a saved
//   state would make every subsequent wake refuse. Wake + stop first.

import { rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { findWell, resolveLumeName, updateWellMemory } from "./registry.ts";
import { readRuntime } from "./wellRuntime.ts";
import { normalizeSize, sizeToBytes } from "./wellPolicy.ts";
import { LumeClient } from "../engine/vwell.ts";
import { withWellLock } from "./wellLock.ts";
import { log } from "./log.ts";

export type ResizeResult =
  | { kind: "resized"; memory: string; memory_bytes: number }
  | { kind: "not_found" }
  | { kind: "refused"; code: "well_not_stopped" | "well_hibernating"; message: string };

export interface ResizeDeps {
  findWell(name: string): Promise<unknown | null | undefined>;
  resolveLumeName(name: string): Promise<string>;
  readRuntimeState(name: string): Promise<string | null>;
  lumeStatus(name: string): Promise<string | null>;
  readBundleConfig(lumeName: string): Promise<Record<string, unknown>>;
  writeBundleConfig(lumeName: string, cfg: Record<string, unknown>): Promise<void>;
  updateWellMemory(name: string, memory: string): Promise<unknown | undefined>;
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

function bundleConfigPath(lumeName: string): string {
  // Same location readLumeMac (lib/createWell.ts) already reads from.
  return join(homedir(), ".lume", lumeName, "config.json");
}

const realDeps: ResizeDeps = {
  findWell,
  resolveLumeName,
  readRuntimeState: async (n) => (await readRuntime(n))?.state ?? null,
  lumeStatus: async (n) => {
    const info = await new LumeClient().info(await resolveLumeName(n)).catch(() => null);
    return info?.status ?? null;
  },
  readBundleConfig: async (lumeName) => {
    const text = await Bun.file(bundleConfigPath(lumeName)).text();
    return JSON.parse(text) as Record<string, unknown>;
  },
  writeBundleConfig: async (lumeName, cfg) => {
    // Atomic: tmp + rename, same hygiene as the registry writes.
    const path = bundleConfigPath(lumeName);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(cfg, null, 2));
    await rename(tmp, path);
  },
  updateWellMemory,
  withLock: withWellLock,
};

// Resize a well's memory. `spec` is the sprites-shaped size string
// ("2GB"). Throws on an invalid spec (caller maps to 400); state
// refusals come back as typed results (caller maps to 409).
export async function resizeWellMemory(
  name: string,
  spec: string,
  deps: ResizeDeps = realDeps,
): Promise<ResizeResult> {
  const memory = normalizeSize(spec); // throws on garbage — caller's 400
  const memoryBytes = sizeToBytes(memory);

  return await deps.withLock(name, async () => {
    if (!(await deps.findWell(name))) return { kind: "not_found" } as const;

    const state = await deps.readRuntimeState(name);
    if (state === "hibernating") {
      return {
        kind: "refused",
        code: "well_hibernating",
        message:
          "cannot resize a hibernating well — the saved state pins its memory size; wake + stop it first",
      } as const;
    }
    // Down-check is lume's call alone. The runtime record is intent,
    // not observation — stopWell never writes it (resurrect-across-
    // bounces keys on the stale alive_running), so a cleanly stopped
    // well reads "alive_running + lume=stopped" forever. Requiring
    // runtime=stopped here 409'd every real resize (cells, 2026-06-10
    // 05:45Z); the only runtime state that matters is `hibernating`
    // above, which hibernate genuinely writes.
    const lume = await deps.lumeStatus(name);
    if (lume === "running") {
      return {
        kind: "refused",
        code: "well_not_stopped",
        message: `cannot resize while the well is up (lume=running) — stop it first`,
      } as const;
    }

    const lumeName = await deps.resolveLumeName(name);
    const cfg = await deps.readBundleConfig(lumeName);
    const before = cfg.memorySize;
    cfg.memorySize = memoryBytes;
    await deps.writeBundleConfig(lumeName, cfg);
    await deps.updateWellMemory(name, memory);
    log.info("resize: memory updated", {
      name,
      lume_name: lumeName,
      from_bytes: before,
      to_bytes: memoryBytes,
      memory,
    });
    return { kind: "resized", memory, memory_bytes: memoryBytes } as const;
  });
}
