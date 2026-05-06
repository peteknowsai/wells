// ssh-keygen wrapper. Generates an ed25519 keypair at a given path, returns
// the public key. Idempotent — re-runs return the existing key.

import { spawn } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureSshKey(
  privatePath: string,
  comment: string,
): Promise<string> {
  await mkdir(dirname(privatePath), { recursive: true, mode: 0o700 });
  const publicPath = `${privatePath}.pub`;

  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    const proc = spawn(
      [
        "ssh-keygen",
        "-t", "ed25519",
        "-N", "",
        "-C", comment,
        "-f", privatePath,
      ],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`ssh-keygen failed (exit ${code}): ${err}`);
    }
    await chmod(privatePath, 0o600);
  }

  return (await readFile(publicPath, "utf-8")).trim();
}
