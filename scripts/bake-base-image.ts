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
// /etc/.wells-base-ready, shutdown, save the baked disk.img back as the
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
import { readDhcpLease } from "../lib/dhcp.ts";
import {
  CURRENT_IMAGE_CONTRACT_VERSION,
  setAlias,
} from "../lib/imageStore.ts";
import { PATHS, ensureStateDirs } from "../lib/state.ts";
import { LumeClient } from "../engine/vwell.ts";
import { bundleDir, bundleDiskPath } from "../engine/bundle.ts";

const RELEASE = "25.10";
const STAGING_NAME = "wells-base-stage";
const WELL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATES_DIR = join(WELL_ROOT, "templates");
const TEMPLATE_PATH = join(TEMPLATES_DIR, "cloud-init-base.yaml");

async function bakeStage1(
  dir: string,
  cloudImage: string,
  hostname: string,
): Promise<{
  buildKeyPath: string;
  isoPath: string;
}> {
  if (!existsSync(cloudImage)) {
    throw new Error(
      `${cloudImage} missing — run scripts/build-base-image.ts first`,
    );
  }

  const buildKeyPath = join(dir, "build-key");
  const pubkey = await ensureSshKey(buildKeyPath, `wells-build@${RELEASE}`);
  log.info("build ssh key ready", { path: buildKeyPath });

  const template = await Bun.file(TEMPLATE_PATH).text();
  const firstbootSh = await Bun.file(
    join(TEMPLATES_DIR, "well-firstboot.sh"),
  ).text();
  const firstbootService = await Bun.file(
    join(TEMPLATES_DIR, "well-firstboot.service"),
  ).text();
  const composed = composeBaseUserData(template, [pubkey], {
    shellScript: firstbootSh,
    serviceUnit: firstbootService,
  });
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
      join(WELL_ROOT, "scripts", "make-cloud-init-seed.ts"),
      composedPath,
      isoPath,
      `--network-config=${networkConfigPath}`,
      `--hostname=${hostname}`,
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

  // Kill any leftover `lume run` subprocess from a prior bake — lume.delete
  // alone won't terminate it, leading to two VMs racing on the same name.
  const pkill = spawn(
    ["pkill", "-TERM", "-f", `lume run ${STAGING_NAME}`],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
  await pkill.exited;
  await Bun.sleep(1500);

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

async function bootStaging(
  cidataPath: string,
  hostname: string,
): Promise<string> {
  // Use lume's HTTP API — `lume run` (CLI mode) holds the VM in its own
  // process and lume serve doesn't reflect that VM's status, so the
  // waitForStatus poll below would spin until timeout. lume serve's
  // /run endpoint is what we use everywhere else (createWell, etc.)
  // and both stable and dev welld inherit ownership cleanly.
  log.info("starting staging via lume HTTP /run", { name: STAGING_NAME });
  const lume = new LumeClient();
  await lume.start(STAGING_NAME, { mount: cidataPath, noDisplay: true });
  await lume.waitForStatus(STAGING_NAME, "running", {
    timeoutMs: 60_000,
    intervalMs: 1000,
  });
  log.info("staging VM is running");

  // Lume's API leaves ipAddress null on Apple Virt — we read the host's
  // vmnet DHCP leases by the unique-per-bake hostname.
  const ip = await waitForDhcpLease(hostname, 90_000);
  log.info("staging VM has DHCP lease", { ip });
  return ip;
}

async function waitForDhcpLease(
  hostname: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ip = await readDhcpLease(hostname);
    if (ip) return ip;
    await Bun.sleep(2000);
  }
  throw new Error(`no DHCP lease for hostname '${hostname}' within ${timeoutMs}ms`);
}

async function sshExec(
  ip: string,
  keyPath: string,
  cmd: string,
  timeoutSec = 10,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", `ConnectTimeout=${timeoutSec}`,
      "-o", "LogLevel=ERROR",
      "-i", keyPath,
      `ubuntu@${ip}`,
      cmd,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

async function pollMarkerReady(
  ip: string,
  keyPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const r = await sshExec(
      ip,
      keyPath,
      "test -f /etc/.wells-base-ready && echo ready || cloud-init status 2>&1 | head -1",
    );
    if (r.code === 0 && r.stdout.trim() === "ready") {
      log.info("cloud-init complete; marker file present");
      return;
    }
    if (r.stdout.trim() !== lastStatus) {
      log.info("cloud-init in progress", { status: r.stdout.trim() });
      lastStatus = r.stdout.trim();
    }
    await Bun.sleep(10_000);
  }
  throw new Error(`cloud-init did not finish within ${timeoutMs}ms`);
}

async function shutdownGuest(ip: string, keyPath: string): Promise<void> {
  log.info("shutting down guest via ssh");
  // Tell systemd to halt cleanly (flush filesystems). Detach via nohup so
  // ssh doesn't hang waiting for the kernel to take down the network.
  await sshExec(
    ip,
    keyPath,
    "sudo nohup shutdown -h now >/dev/null 2>&1 &",
  );
  // Give the guest a beat to actually halt.
  await Bun.sleep(8000);
  // Lume.app's subprocess won't notice a guest halt; explicitly tell lume
  // to stop the VM so it tears down and the status flips.
  log.info("issuing lume stop");
  const lume = new LumeClient();
  await lume.stop(STAGING_NAME).catch((e) =>
    log.warn("lume stop returned error (may already be stopping)", { e: String(e) }),
  );
  await lume.waitForStatus(STAGING_NAME, "stopped", {
    timeoutMs: 60_000,
    intervalMs: 2000,
  });
  log.info("guest is stopped");
}

async function freezeBakedDisk(finalDisk: string): Promise<void> {
  const stagingDisk = bundleDiskPath(STAGING_NAME);
  log.info("clonefile baked disk → final", {
    from: stagingDisk,
    to: finalDisk,
  });
  await clonefile(stagingDisk, finalDisk);
  log.info("baked disk frozen");
  // Delete the staging bundle now that we've extracted what we wanted.
  const lume = new LumeClient();
  await lume.delete(STAGING_NAME);
  log.info("staging bundle deleted");
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

  // Unique hostname per bake — DHCP leases keyed on hostname, so prior
  // runs would otherwise collide and serve a stale IP.
  const hostname = `wells-base-${Date.now().toString(36)}`;

  await bakeStage1(dir, cloudImage, hostname);

  if (existsSync(finalDisk) && !force) {
    log.info("baked disk.img exists; skip stage 2", { path: finalDisk });
    return;
  }

  await ensureRawImage(cloudImage, rawImage);
  await bakeStage2(rawImage);

  const isoPath = join(dir, "cidata.iso");
  const buildKeyPath = join(dir, "build-key");
  const ip = await bootStaging(isoPath, hostname);

  // Bake installs: apt set + Node + Bun + Rust + cargo install stoolap
  // (compile from source) + npm install Claude Code + pi-coding-agent +
  // pi-web-access. Stoolap compile alone can run 5+ min on a fresh
  // toolchain. 35 min covers worst-case + headroom.
  await pollMarkerReady(ip, buildKeyPath, 35 * 60_000);
  await shutdownGuest(ip, buildKeyPath);
  await freezeBakedDisk(finalDisk);

  // Stamp the image meta.json so create-from-image (which gates on
  // image_contract_version) accepts forks from this base. Bake script
  // is the only producer of ubuntu-<RELEASE>-base; mirror what
  // saveImage produces for non-base saves.
  const metaPath = join(dir, "meta.json");
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        name: `ubuntu-${RELEASE}-base`,
        from_well: null,
        from_disk_size: null,
        created_at: new Date().toISOString(),
        image_contract_version: CURRENT_IMAGE_CONTRACT_VERSION,
        saved_with_welld_version: process.env.WELL_VERSION ?? "1.0.0",
        rinsed: false,
        // W.72: bake script always pulls templates/well-firstboot.sh
        // fresh, which includes the WELL_STATIC_IP_CIDR handler. Any
        // image produced by this script supports the static-IP path
        // by construction.
        firstboot_supports_static_ip: true,
        notes: "Baked from cloud-image via scripts/bake-base-image.ts",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  // Point the `ubuntu-base` mutable alias at the freshly baked image so
  // downstream consumers (cells team, pool fill, anyone passing
  // --from-image=ubuntu-base) pick up the new baseline automatically.
  // Immutable consumers can still pin to `ubuntu-<RELEASE>-base`.
  try {
    await setAlias("ubuntu-base", `ubuntu-${RELEASE}-base`);
    log.info("alias updated", {
      alias: "ubuntu-base",
      target: `ubuntu-${RELEASE}-base`,
    });
  } catch (e) {
    log.warn("alias update failed (image baked, alias unchanged)", {
      err: (e as Error).message,
    });
  }

  log.info("bake complete", { disk: finalDisk, meta: metaPath });
}

await main();
