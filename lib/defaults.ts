// Well resource defaults. Stored at ~/.wells/defaults.json so users can
// tune them globally without per-create flags. Defaults are tuned for a
// shared Mac Mini host, not bare-metal sprites — multiple wells cohabit
// one box.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateRoot } from "./state.ts";

export interface WellDefaults {
  cpu: number;
  memory: string;
  disk: string;
  // Global default idle threshold for the autosleep watchdog. Wells with
  // `auto_sleep_seconds` unset on their record fall back to this. Set to
  // null to never auto-sleep by default. Per-well overrides on the
  // record take precedence.
  auto_sleep_seconds: number | null;
  // How many checkpoints to retain per well (Phase A.4). Older ones
  // GC at create time. Per-checkpoint TTL (`retain_for_seconds`) trumps
  // this — TTL'd checkpoints expire on schedule regardless of count.
  checkpoint_retain_count: number;
  // W.72 — static IP range welld manages. Wells created without an
  // explicit operator pin get allocated from here at create time and
  // skip DHCP entirely (cidata netplan writes the static config).
  // Format: "<start>-<end>" inside 192.168.64.0/24, e.g. "200-250".
  // Set to null to disable static allocation (legacy DHCP path).
  // Default (.200-.250) sits above bootpd's typical .2-.150 grant
  // range and gives 51 slots — well past Tier 4's running depth.
  static_ip_range: string | null;
}

export const HARDCODED_DEFAULTS: WellDefaults = {
  cpu: 4,
  // 1 GB default (down from 4 GB sprites-derived). Pi cells typically
  // work with 400-700 MB at peak; 1 GB covers worst-case bursts with
  // headroom. Cloud-init also seeds a 512 MB swap as a safety net for
  // outlier spikes. Heavy-workload cells should opt into more via
  // `well create --memory 2GB`. See docs/memory-budget.md for the
  // chunks model and future dynamic-allocation design.
  memory: "1GB",
  disk: "50GB",
  // 60s by Pete's call. With cooperative pause (cells fires POST
  // /lifecycle {idle} on agent_end → welld's fast-sleep grace timer),
  // this is mostly a fallback for non-cooperative cells; cooperative
  // cells hibernate within the grace window and never reach this.
  auto_sleep_seconds: 60,
  checkpoint_retain_count: 5,
  // W.72: static IP range welld manages. Default "200-250" lives above
  // bootpd's typical grant pool (.2-.150) so the two ranges don't
  // collide. Operator override via defaults.json's static_ip_range
  // ("210-220" to narrow, null to disable + fall back to legacy DHCP).
  // Welld refuses to start if the configured range overlaps bootpd's
  // declared range (see ipPool.checkBootpdOverlap).
  static_ip_range: "200-250",
};

export function defaultsPath(): string {
  return join(stateRoot(), "defaults.json");
}

export async function loadDefaults(): Promise<WellDefaults> {
  const path = defaultsPath();
  if (!existsSync(path)) return { ...HARDCODED_DEFAULTS };
  const text = await readFile(path, "utf-8");
  const parsed = JSON.parse(text) as Partial<WellDefaults>;
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
    // `null` is meaningful (legacy DHCP path).
    static_ip_range:
      "static_ip_range" in parsed
        ? parsed.static_ip_range!
        : HARDCODED_DEFAULTS.static_ip_range,
  };
}

export async function saveDefaults(d: WellDefaults): Promise<void> {
  const path = defaultsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}
