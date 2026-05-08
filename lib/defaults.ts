// Splite resource defaults. Stored at ~/.splites/defaults.json so users can
// tune them globally without per-create flags. Defaults are tuned for a
// shared Mac Mini host, not bare-metal sprites — multiple splites cohabit
// one box.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateRoot } from "./state.ts";

export interface SpliteDefaults {
  cpu: number;
  memory: string;
  disk: string;
  // Global default idle threshold for the autosleep watchdog. Splites with
  // `auto_sleep_seconds` unset on their record fall back to this. Set to
  // null to never auto-sleep by default. Per-splite overrides on the
  // record take precedence.
  auto_sleep_seconds: number | null;
  // How many checkpoints to retain per splite (Phase A.4). Older ones
  // GC at create time. Per-checkpoint TTL (`retain_for_seconds`) trumps
  // this — TTL'd checkpoints expire on schedule regardless of count.
  checkpoint_retain_count: number;
}

export const HARDCODED_DEFAULTS: SpliteDefaults = {
  cpu: 4,
  // 1 GB default (down from 4 GB sprites-derived). Pi cells typically
  // work with 400-700 MB at peak; 1 GB covers worst-case bursts with
  // headroom. Cloud-init also seeds a 512 MB swap as a safety net for
  // outlier spikes. Heavy-workload cells should opt into more via
  // `splite create --memory 2GB`. See docs/memory-budget.md for the
  // chunks model and future dynamic-allocation design.
  memory: "1GB",
  disk: "50GB",
  // 60s by Pete's call. With cooperative pause (extensions/pi/splite-
  // cooperate fires /sleep on agent_end), this is mostly a fallback for
  // non-cooperative cells; cooperative cells pause within milliseconds
  // of an LLM turn ending and never reach this threshold.
  auto_sleep_seconds: 60,
  checkpoint_retain_count: 5,
};

export function defaultsPath(): string {
  return join(stateRoot(), "defaults.json");
}

export async function loadDefaults(): Promise<SpliteDefaults> {
  const path = defaultsPath();
  if (!existsSync(path)) return { ...HARDCODED_DEFAULTS };
  const text = await readFile(path, "utf-8");
  const parsed = JSON.parse(text) as Partial<SpliteDefaults>;
  return {
    cpu: parsed.cpu ?? HARDCODED_DEFAULTS.cpu,
    memory: parsed.memory ?? HARDCODED_DEFAULTS.memory,
    disk: parsed.disk ?? HARDCODED_DEFAULTS.disk,
    // `null` is meaningful (never sleep), so check key presence not just
    // truthiness when reading the override from disk.
    auto_sleep_seconds:
      "auto_sleep_seconds" in parsed
        ? parsed.auto_sleep_seconds!
        : HARDCODED_DEFAULTS.auto_sleep_seconds,
    checkpoint_retain_count:
      parsed.checkpoint_retain_count ?? HARDCODED_DEFAULTS.checkpoint_retain_count,
  };
}

export async function saveDefaults(d: SpliteDefaults): Promise<void> {
  const path = defaultsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}
