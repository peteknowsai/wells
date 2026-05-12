// Shared "which well are we talking about" resolution.
// Order: explicit flag → positional arg (info-style) → .well pin in cwd.

import { existsSync } from "node:fs";
import { join } from "node:path";

export async function readWellPin(
  cwd: string = process.cwd(),
): Promise<string | undefined> {
  const path = join(cwd, ".well");
  if (!existsSync(path)) return undefined;
  try {
    const obj = JSON.parse(await Bun.file(path).text());
    return typeof obj.well === "string" ? obj.well : undefined;
  } catch {
    return undefined;
  }
}
