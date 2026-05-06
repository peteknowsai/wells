#!/usr/bin/env bun
// Build a NoCloud cidata ISO from a cloud-init user-data file.
//
// Cloud-init's NoCloud datasource looks for a filesystem labeled CIDATA
// containing user-data + meta-data. macOS hdiutil produces an iso9660+joliet
// image with the right volume label. lume run --usb-storage=<this iso>
// attaches it; the guest's cloud-init picks it up on first boot.
//
// Usage: bun run scripts/make-cloud-init-seed.ts <user-data.yaml> <output.iso>
//        [--instance-id=<id>] [--hostname=<name>]
//
// Default instance-id: splites-<sha1 of user-data, 12 chars> (idempotent).
// Default hostname:    splites-base.

import { mkdtemp, copyFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

function flag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const a = args.find((x) => x.startsWith(prefix));
  return a?.slice(prefix.length);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help") || args.length < 2) {
    console.log(
      "Usage: bun run scripts/make-cloud-init-seed.ts <user-data.yaml> <output.iso>\n" +
        "       [--instance-id=<id>] [--hostname=<name>]",
    );
    process.exit(args.length < 2 ? 64 : 0);
  }

  const userDataPath = args[0]!;
  const outputPath = args[1]!;
  if (!existsSync(userDataPath)) {
    console.error(`user-data not found: ${userDataPath}`);
    process.exit(1);
  }

  const userData = await Bun.file(userDataPath).text();
  const instanceId =
    flag(args, "instance-id") ??
    `splites-${createHash("sha1").update(userData).digest("hex").slice(0, 12)}`;
  const hostname = flag(args, "hostname") ?? "splites-base";

  const stage = await mkdtemp(join(tmpdir(), "cidata-stage-"));
  try {
    await copyFile(userDataPath, join(stage, "user-data"));
    await writeFile(
      join(stage, "meta-data"),
      `instance-id: ${instanceId}\nlocal-hostname: ${hostname}\n`,
    );

    const proc = Bun.spawn(
      [
        "hdiutil",
        "makehybrid",
        "-iso",
        "-joliet",
        "-default-volume-name",
        "CIDATA",
        "-o",
        outputPath,
        stage,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`hdiutil failed (exit ${code}): ${err}`);
    }
    console.log(`wrote ${outputPath}`);
    console.log(`  instance-id: ${instanceId}`);
    console.log(`  hostname:    ${hostname}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

await main();
