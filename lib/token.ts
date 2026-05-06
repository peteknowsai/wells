// Splited's bearer token. Lives at ~/.splites/token, mode 0600.
// Generated on first daemon boot, persisted, never rotated automatically —
// rotating it would invalidate every CLI invocation pinned via env.
//
// Sprites parity: Authorization: Bearer $SPLITES_TOKEN.

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "./state.ts";

export async function ensureToken(): Promise<string> {
  const path = PATHS.token();
  if (existsSync(path)) {
    const t = (await readFile(path, "utf-8")).trim();
    if (t.length > 0) return t;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  await writeFile(path, token + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
  return token;
}

export async function readToken(): Promise<string | null> {
  const path = PATHS.token();
  if (!existsSync(path)) return null;
  const t = (await readFile(path, "utf-8")).trim();
  return t.length > 0 ? t : null;
}
