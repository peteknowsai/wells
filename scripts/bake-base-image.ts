#!/usr/bin/env bun
// Bake the Ubuntu 25.10 base image.
//
// Stage 1 (always runs, idempotent):
//   - Generate a build-time ssh keypair.
//   - Compose the static cloud-init template with the build pubkey.
//   - Emit a cidata ISO.
//
// Stage 2 (skipped if disk.img already baked, unless --force):
//   - lume create a staging bundle (linux, sized for headroom).
//   - Wait for provisioning to finish.
//   - APFS-clonefile cloud-image.img into the bundle's disk.img.
//
// Stage 3 (next iteration): boot the staged VM with cidata attached, poll
// /etc/.splites-base-ready, shutdown, save the baked disk.img back as the
// frozen base.
//
// Preconditions: scripts/build-base-image.ts has populated cloud-image.img.

import { writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";

import { log } from "../lib/log.ts";
import { ensureSshKey } from "../lib/sshKey.ts";
import { composeBaseUserData } from "../lib/cloudInit.ts";
import { clonefile } from "../lib/clonefile.ts";
import { PATHS, ensureStateDirs } from "../lib/state.ts";
import { LumeClient } from "../engine/lume.ts";
import { bundleDir, bundleDiskPath } from "../engine/bundle.ts";

const RELEASE = "25.10";
const STAGING_NAME = "splites-base-stage";
const SPLITES_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE_PATH = join(SPLITES_ROOT, "templates", "cloud-init-base.yaml");

async function bakeStage1(dir: string, cloudImage: string): Promise<{
  buildKeyPath: string;
  isoPath: string;
}> {
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

  // network-config: DHCP every NIC. Apple Virt's VirtIO interface name varies
  // and isn't always eth0, so we match wildcard. Without this, cloud-init's
  // default config doesn't bring up DHCP and the guest never gets internet.
  const networkConfigPath = join(dir, "network-config.yaml");
  await writeFile(
    networkConfigPath,
    `version: 2\nethernets:\n  all:\n    match:\n      name: "*"\n    dhcp4: true\n`,
  );
  log.info("wrote default network-config", { path: networkConfigPath });

  const isoPath = join(dir, "cidata.iso");
  const seed = spawn(
    [
      "bun",
      "run",
      join(SPLITES_ROOT, "scripts", "make-cloud-init-seed.ts"),
      composedPath,
      isoPath,
      `--network-config=${networkConfigPath}`,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const code = await seed.exited;
  if (code !== 0) {
    const err = await new Response(seed.stderr).text();
    throw new Error(`make-cloud-init-seed failed (exit ${code}): ${err}`);
  }
  log.info("cidata iso ready", { path: isoPath });

  return { buildKeyPath, isoPath };
}

async function ensureRawImage(qcowPath: string, rawPath: string): Promise<void> {
  const which = spawn(["which", "qemu-img"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  await which.exited;
  if (which.exitCode !== 0) {
    throw new Error(
      "qemu-img not on PATH — install with `brew install qemu` (one-time)",
    );
  }

  if (existsSync(rawPath)) {
    const rawStat = await stat(rawPath);
    const qcowStat = await stat(qcowPath);
    if (rawStat.mtimeMs >= qcowStat.mtimeMs) {
      log.info("raw image already current; skip conversion", { path: rawPath });
      return;
    }
  }

  log.info("converting qcow2 → raw", { from: qcowPath, to: rawPath });
  const proc = spawn(
    ["qemu-img", "convert", "-f", "qcow2", "-O", "raw", qcowPath, rawPath],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  if ((await proc.exited) !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`qemu-img convert failed: ${err}`);
  }
  log.info("raw image ready", { path: rawPath });
}

async function bakeStage2(rawCloudImage: string): Promise<void> {
  const lume = new LumeClient();

  const existing = await lume.list().catch(() => [] as Array<{ name: string }>);
  if (existing.some((v) => v.name === STAGING_NAME)) {
    log.info("staging bundle exists; deleting for fresh build", {
      name: STAGING_NAME,
    });
    await lume.delete(STAGING_NAME);
  }

  log.info("creating staging bundle", { name: STAGING_NAME });
  await lume.create({
    name: STAGING_NAME,
    os: "linux",
    cpu: 4,
    memory: "4GB",
    diskSize: "20GB",
    display: "1024x768",
  });

  log.info("waiting for staging bundle to finish provisioning");
  await lume.waitForStatus(STAGING_NAME, "stopped", { timeoutMs: 60_000 });
  log.info("staging bundle provisioned", { dir: bundleDir(STAGING_NAME) });

  const stagingDisk = bundleDiskPath(STAGING_NAME);
  log.info("clonefile raw cloud-image → staging disk", {
    from: rawCloudImage,
    to: stagingDisk,
  });
  await clonefile(rawCloudImage, stagingDisk);

  // Cloud-image is 881 MB; cloud-init's growpart needs headroom to install
  // packages. truncate up to 20 GB (sparse — costs nothing on APFS).
  const truncProc = spawn(["truncate", "-s", "20G", stagingDisk], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  if ((await truncProc.exited) !== 0) {
    const err = await new Response(truncProc.stderr).text();
    throw new Error(`truncate failed: ${err}`);
  }
  log.info("disk resized", { stagingDisk, size: "20G" });
}

async function bootStaging(cidataPath: string): Promise<void> {
  const logPath = "/tmp/splites-bake-lume-run.log";
  const logFd = openSync(logPath, "a");
  log.info("spawning lume run (detached)", { name: STAGING_NAME, log: logPath });
  const proc = spawn(
    [
      "lume",
      "run",
      STAGING_NAME,
      "--no-display",
      `--usb-storage=${cidataPath}`,
    ],
    { stdout: logFd, stderr: logFd, stdin: "ignore" },
  );
  proc.unref();

  // Poll lume's API for the status flip. Allow up to 60s — boot kickoff is
  // async and the lume.app binary needs a moment to take the VM live.
  const lume = new LumeClient();
  const info = await lume.waitForStatus(STAGING_NAME, "running", {
    timeoutMs: 60_000,
    intervalMs: 1000,
  });
  log.info("staging VM is running", {
    name: STAGING_NAME,
    ip: info.ipAddress,
    status: info.status,
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(
      "Usage: bun run scripts/bake-base-image.ts [--force]\n\n" +
        "Bakes the Ubuntu 25.10 base image. Idempotent: skips if\n" +
        "disk.img already exists. --force re-bakes.",
    );
    return;
  }
  const force = process.argv.includes("--force");

  await ensureStateDirs();
  const dir = PATHS.imageDir(`ubuntu-${RELEASE}-base`);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const cloudImage = join(dir, "cloud-image.img");
  const rawImage = join(dir, "cloud-image.raw");
  const finalDisk = join(dir, "disk.img");

  await bakeStage1(dir, cloudImage);

  if (existsSync(finalDisk) && !force) {
    log.info("baked disk.img exists; skip stage 2", { path: finalDisk });
    return;
  }

  await ensureRawImage(cloudImage, rawImage);
  await bakeStage2(rawImage);

  const isoPath = join(dir, "cidata.iso");
  await bootStaging(isoPath);

  log.info("stage 2 partial complete (cloud-init monitor + freeze is next iter)");
}

await main();
