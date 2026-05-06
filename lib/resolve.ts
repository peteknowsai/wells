// Shared "which splite are we talking about" resolution.
// Order: explicit flag → positional arg (info-style) → .splite pin in cwd.

import { existsSync } from "node:fs";
import { join } from "node:path";

export async function readSplitePin(
  cwd: string = process.cwd(),
): Promise<string | undefined> {
  const path = join(cwd, ".splite");
  if (!existsSync(path)) return undefined;
  try {
    const obj = JSON.parse(await Bun.file(path).text());
    return typeof obj.splite === "string" ? obj.splite : undefined;
  } catch {
    return undefined;
  }
}
