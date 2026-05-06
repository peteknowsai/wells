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
}

export const HARDCODED_DEFAULTS: SpliteDefaults = {
  cpu: 4,
  memory: "4GB",
  disk: "50GB",
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
  };
}

export async function saveDefaults(d: SpliteDefaults): Promise<void> {
  const path = defaultsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}
