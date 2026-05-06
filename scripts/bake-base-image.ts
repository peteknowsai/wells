#!/usr/bin/env bun
// Bake the Ubuntu 25.10 base image. Stage 1 of 2:
//   1. Generate a build-time ssh keypair (idempotent).
//   2. Compose the static cloud-init template with the build pubkey.
//   3. Emit a cidata ISO ready for lume to attach as --usb-storage.
//
// Stage 2 (next iteration): lume create + disk swap + boot + monitor + freeze.
//
// Preconditions: scripts/build-base-image.ts has populated cloud-image.img.

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";

import { log } from "../lib/log.ts";
import { ensureSshKey } from "../lib/sshKey.ts";
import { composeBaseUserData } from "../lib/cloudInit.ts";
import { PATHS, ensureStateDirs } from "../lib/state.ts";

const RELEASE = "25.10";
const SPLITES_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE_PATH = join(SPLITES_ROOT, "templates", "cloud-init-base.yaml");

async function main(): Promise<void> {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(
      "Usage: bun run scripts/bake-base-image.ts\n\n" +
        "Generates the build-time ssh key and cidata ISO that the\n" +
        "lume orchestration step will consume.",
    );
    return;
  }

  await ensureStateDirs();
  const dir = PATHS.imageDir(`ubuntu-${RELEASE}-base`);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const cloudImage = join(dir, "cloud-image.img");
  if (!existsSync(cloudImage)) {
    throw new Error(
      `${cloudImage} missing — run scripts/build-base-image.ts first`,
    );
  }

  const buildKeyPath = join(dir, "build-key");
  const pubkey = await ensureSshKey(buildKeyPath, `splites-build@${RELEASE}`);
  log.info("build ssh key ready", { path: buildKeyPath });

  const template = await Bun.file(TEMPLATE_PATH).text();
  const composed = composeBaseUserData(template, [pubkey]);
  const composedPath = join(dir, "user-data.composed.yaml");
  await writeFile(composedPath, composed, { mode: 0o600 });
  log.info("composed user-data", { path: composedPath });

  const isoPath = join(dir, "cidata.iso");
  const seed = spawn(
    [
      "bun",
      "run",
      join(SPLITES_ROOT, "scripts", "make-cloud-init-seed.ts"),
      composedPath,
      isoPath,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const code = await seed.exited;
  if (code !== 0) {
    const err = await new Response(seed.stderr).text();
    throw new Error(`make-cloud-init-seed failed (exit ${code}): ${err}`);
  }
  log.info("cidata iso ready", { path: isoPath });

  log.info("bake stage 1 complete", {
    cloud_image: cloudImage,
    build_key: buildKeyPath,
    cidata: isoPath,
  });
}

await main();
