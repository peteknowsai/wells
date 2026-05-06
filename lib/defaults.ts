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
}

export const HARDCODED_DEFAULTS: SpliteDefaults = {
  cpu: 4,
  memory: "4GB",
  disk: "50GB",
  auto_sleep_seconds: 600,
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
  };
}

export async function saveDefaults(d: SpliteDefaults): Promise<void> {
  const path = defaultsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}
