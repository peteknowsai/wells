#!/usr/bin/env bun
// A.2 R2 round-trip smoke.
//
// Creates a well with R2 config, takes a checkpoint (welld auto-uploads to R2),
// verifies the R2 object exists, sha256s the local disk, deletes the local
// checkpoint dir, restores from R2, sha256s the restored disk, asserts they
// match. Cleanup destroys the well + the R2 object on success.
//
// Usage:
//   bun run scripts/smoke-r2-sync.ts [--name=<name>] [--keep] [--image=<img>]
//                                     [--bucket=<b>]
//
// Required env:
//   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//
// Optional:
//   WELL_BASE_URL — defaults to http://127.0.0.1:7879 (dev welld). Auto-resolves
//                   the token path from this (~/.wells-dev/token for :7879,
//                   ~/.wells/token otherwise — but smoke should run on dev).
//
// Bucket setup (one-time, tear down at end of smoke run):
//   wrangler r2 bucket create wells-smoke-r2
//   …after smoke: wrangler r2 bucket delete wells-smoke-r2

import { homedir } from "node:os";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { S3Client } from "bun";

const BASE_URL = process.env.WELL_BASE_URL ?? "http://127.0.0.1:7879";
const STATE_DIR = join(
  homedir(),
  BASE_URL.includes(":7879") ? ".wells-dev" : ".wells",
);

interface Args {
  name: string;
  keep: boolean;
  image: string;
  bucket: string;
}

function parseArgs(argv: string[]): Args {
  const flag = (k: string, def: string): string => {
    const long = argv.find((a) => a.startsWith(`--${k}=`));
    return long ? long.slice(k.length + 3) : def;
  };
  return {
    name: flag("name", `r2smoke${Date.now().toString(36).slice(-6)}`),
    keep: argv.includes("--keep"),
    image: flag("image", "ubuntu-25.10-base"),
    bucket: flag("bucket", "wells-smoke-r2"),
  };
}

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) {
    console.error(`error: ${k} not set`);
    process.exit(1);
  }
  return v;
}

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = (await readFile(join(STATE_DIR, "token"), "utf-8")).trim();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function sha256OfFile(path: string): Promise<string> {
  // Streaming hash — disk.img is 50GB sparse, readFile() OOMs on a 50GB
  // logical buffer even though most blocks are zeros.
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const r2Endpoint = requireEnv("R2_ENDPOINT");
  const r2Key = requireEnv("R2_ACCESS_KEY_ID");
  const r2Secret = requireEnv("R2_SECRET_ACCESS_KEY");

  console.log(
    `smoke-r2-sync: target=${BASE_URL}, well=${args.name}, bucket=${args.bucket}, image=${args.image}`,
  );
  const t0 = Date.now();

  // 1. Create well with R2 config. fork-from-image is sub-3s on dev with the
  // pool empty; this call returns once the well is alive_running.
  console.log("[1/7] create well with R2 config…");
  // Default sizing (cpu=4, memory=1GB, disk=50GB) — shrinking disk
  // below the image's formatted size (50GB for ubuntu-25.10-base)
  // truncates the ext4 mid-structure and the guest can't boot, so
  // never gets a DHCP lease. Bisected 2026-05-10: disk: "10GB"
  // was the smoke's create-killer. Use defaults (smaller cpu/memory
  // overrides remain safe).
  await api("POST", "/v1/wells", {
    name: args.name,
    cpu: 2,
    memory: "2GB",
    from_image: args.image,
    r2: {
      endpoint: r2Endpoint,
      bucket: args.bucket,
      access_key_id: r2Key,
      secret_access_key: r2Secret,
    },
  });
  console.log(`  → created in ${Date.now() - t0}ms`);

  // Disable autosleep so the watchdog doesn't hibernate mid-checkpoint
  // (welld's create endpoint ignores auto_sleep_seconds; PATCH it).
  await api("PATCH", `/v1/wells/${args.name}`, { auto_sleep_seconds: null });

  let s3: S3Client | null = null;
  let cpId: string | null = null;
  let cpKey: string | null = null;
  try {
    // 2. Take checkpoint. welld's createCheckpoint kicks off an R2 upload in
    // the background and returns immediately (sparse 50GB disks blow past
    // Bun.serve's 255s idleTimeout otherwise). Poll the list endpoint until
    // r2_uploaded flips true.
    console.log("[2/7] create checkpoint + poll for r2_uploaded…");
    const cp0 = await api<{ id: string }>(
      "POST",
      `/v1/wells/${args.name}/checkpoints`,
      {},
    );
    cpId = cp0.id;
    const t2 = Date.now();
    let cp: { id: string; r2_uploaded: boolean; r2_key?: string } | null = null;
    const POLL_DEADLINE_MS = 45 * 60 * 1000; // 45 min cap (50GB sparse upload at residential bandwidth)
    while (Date.now() - t2 < POLL_DEADLINE_MS) {
      await new Promise((r) => setTimeout(r, 5_000));
      const list = await api<{
        checkpoints: Array<{ id: string; r2_uploaded?: boolean; r2_key?: string }>;
      }>("GET", `/v1/wells/${args.name}/checkpoints`);
      const found = list.checkpoints.find((c) => c.id === cp0.id);
      if (!found) throw new Error(`checkpoint ${cp0.id} vanished from list`);
      const elapsed = ((Date.now() - t2) / 1000).toFixed(0);
      if (found.r2_uploaded && found.r2_key) {
        cp = { id: found.id, r2_uploaded: true, r2_key: found.r2_key };
        console.log(`  → ${cp.id} uploaded to ${cp.r2_key} (${elapsed}s)`);
        break;
      }
      console.log(`  …waiting (${elapsed}s)`);
    }
    if (!cp) throw new Error(`checkpoint ${cp0.id} did not upload to R2 within deadline`);
    cpKey = cp.r2_key!;

    // 3. Verify R2 object exists via S3Client stat.
    console.log("[3/7] verify R2 object exists…");
    s3 = new S3Client({
      endpoint: r2Endpoint,
      bucket: args.bucket,
      accessKeyId: r2Key,
      secretAccessKey: r2Secret,
    });
    const remoteStat = await s3.file(cp.r2_key).stat();
    console.log(`  → R2 object size: ${remoteStat.size} bytes`);

    // 4. sha256 local disk before deletion.
    console.log("[4/7] sha256 local checkpoint disk…");
    const localPath = join(
      STATE_DIR,
      "vms",
      args.name,
      "checkpoints",
      cp.id,
      "disk.img",
    );
    if (!existsSync(localPath)) {
      throw new Error(`local checkpoint disk missing at ${localPath}`);
    }
    const before = await sha256OfFile(localPath);
    console.log(`  → ${before}`);

    // 5. Delete local checkpoint dir (simulating fresh-host loss). Direct fs
    // removal — we deliberately don't use the welld DELETE endpoint because
    // that also drops the R2 object; we want the R2 object to survive so
    // step 6 can pull it back.
    console.log("[5/7] delete local checkpoint dir (simulating fresh-host)…");
    const cpDir = join(STATE_DIR, "vms", args.name, "checkpoints", cp.id);
    await rm(cpDir, { recursive: true, force: true });
    if (existsSync(cpDir)) {
      throw new Error("local cp dir still exists after rm");
    }

    // 6. Restore from R2. Pull the disk via the S3 client directly — welld's
    // synchronous from_r2=true path runs the download inside the request
    // handler, which blows past Bun.serve's 255s idleTimeout for a
    // 50GB sparse object on residential bandwidth. Pulling client-side and
    // calling restore (without from_r2) keeps welld's handler fast (just
    // stop+clonefile+start, ~30s).
    console.log("[6/7] restore from R2 (client-side download + restore)…");
    const t6 = Date.now();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cpDir, { recursive: true, mode: 0o700 });
    const downloaded = s3!.file(cp.r2_key!);
    await Bun.write(localPath, downloaded);
    console.log(`  → downloaded in ${((Date.now() - t6) / 1000).toFixed(1)}s`);
    await api(
      "POST",
      `/v1/wells/${args.name}/checkpoints/${cp.id}/restore`,
    );

    // 7. sha256 restored disk + assert match.
    // restoreCheckpoint stages disk.img back into the checkpoint dir AND
    // copies it onto the live bundle disk. We re-sha256 the checkpoint copy.
    console.log("[7/7] sha256 restored disk + assert match…");
    if (!existsSync(localPath)) {
      throw new Error(`restored disk missing at ${localPath}`);
    }
    const after = await sha256OfFile(localPath);
    console.log(`  → ${after}`);
    if (before !== after) {
      throw new Error(`sha256 mismatch: before=${before}, after=${after}`);
    }

    console.log(
      `\n✅ smoke passed in ${Date.now() - t0}ms — R2 round-trip integrity verified`,
    );
  } finally {
    if (!args.keep) {
      console.log("\ncleanup:");
      try {
        console.log("  destroy well…");
        await api("DELETE", `/v1/wells/${args.name}`);
      } catch (e) {
        console.error(`  destroy well failed: ${(e as Error).message}`);
      }
      if (s3 && cpKey) {
        try {
          console.log("  delete R2 object…");
          await s3.delete(cpKey);
        } catch (e) {
          console.error(`  delete R2 object failed: ${(e as Error).message}`);
        }
      }
    } else {
      console.log("\n(--keep set, skipping cleanup)");
    }
  }
}

main().catch((e) => {
  console.error("\nsmoke-r2-sync failed:", e.message);
  process.exit(1);
});
