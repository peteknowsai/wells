#!/usr/bin/env bun
// Download Ubuntu 25.10 arm64 cloud image to ~/.wells/images/ubuntu-25.10-base/disk.img.
// Idempotent: skips if file exists with matching SHA256. --force to redownload.

import { mkdir, unlink, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { log } from "../lib/log.ts";
import { PATHS, ensureStateDirs } from "../lib/state.ts";

const RELEASE = "25.10";
const ARCH = "arm64";
const IMG_NAME = `ubuntu-${RELEASE}-server-cloudimg-${ARCH}.img`;
const BASE_URL = `https://cloud-images.ubuntu.com/releases/${RELEASE}/release`;
const IMG_URL = `${BASE_URL}/${IMG_NAME}`;
const SHA_URL = `${BASE_URL}/SHA256SUMS`;

async function expectedSha256(): Promise<string> {
  const r = await fetch(SHA_URL);
  if (!r.ok) throw new Error(`SHA256SUMS fetch failed: ${r.status}`);
  const text = await r.text();
  for (const line of text.split("\n")) {
    const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (m && m[2]?.trim() === IMG_NAME) return m[1]!;
  }
  throw new Error(`could not find ${IMG_NAME} in SHA256SUMS`);
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function downloadWithProgress(url: string, dest: string): Promise<void> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed: ${url} → ${r.status}`);
  if (!r.body) throw new Error(`no body in response: ${url}`);
  const total = Number(r.headers.get("content-length") ?? 0);
  const tmp = dest + ".part";
  const writer = Bun.file(tmp).writer();
  let received = 0;
  let lastReport = Date.now();
  for await (const chunk of r.body) {
    writer.write(chunk);
    received += chunk.byteLength;
    if (Date.now() - lastReport > 2000) {
      const pct = total ? Math.round((received / total) * 100) : 0;
      const mb = (received / 1024 / 1024).toFixed(1);
      const totalMb = total ? (total / 1024 / 1024).toFixed(0) : "?";
      log.info("downloading", { mb, total_mb: totalMb, pct });
      lastReport = Date.now();
    }
  }
  await writer.end();
  await rename(tmp, dest);
  log.info("download complete", { dest, bytes: received });
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      `Usage: bun run scripts/build-base-image.ts [--force]\n\n` +
        `Downloads Ubuntu ${RELEASE} ${ARCH} cloud image to\n` +
        `~/.wells/images/ubuntu-${RELEASE}-base/disk.img.\n\n` +
        `Idempotent: skips if file exists with matching SHA256.\n` +
        `--force to redownload.`,
    );
    return;
  }
  const force = process.argv.includes("--force");

  await ensureStateDirs();
  const dir = PATHS.imageDir(`ubuntu-${RELEASE}-base`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, "cloud-image.img");

  log.info("fetching SHA256SUMS", { url: SHA_URL });
  const expected = await expectedSha256();
  log.info("expected sha256", { sha: expected });

  if (existsSync(dest) && !force) {
    log.info("file exists, verifying sha256", { dest });
    const actual = await fileSha256(dest);
    if (actual === expected) {
      log.info("sha256 matches; skip download", { dest });
      return;
    }
    log.warn("sha256 mismatch; redownloading", { dest, actual, expected });
    await unlink(dest);
  } else if (existsSync(dest) && force) {
    log.info("--force: removing existing file", { dest });
    await unlink(dest);
  }

  log.info("downloading", { url: IMG_URL, dest });
  await downloadWithProgress(IMG_URL, dest);

  log.info("verifying sha256");
  const actual = await fileSha256(dest);
  if (actual !== expected) {
    throw new Error(`sha256 mismatch after download: expected ${expected}, got ${actual}`);
  }
  log.info("base image ready", { dest });
}

await main();
