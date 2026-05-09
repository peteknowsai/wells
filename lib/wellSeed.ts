// B.0.9.d.4: per-well seed disk — replaces lib/cloudInitWell.ts.
//
// Old shape: cidata.iso containing cloud-config YAML (user-data) +
// meta-data + network-config. cloud-init read it on first boot.
//
// New shape: cidata.iso containing `well.env` (shell KEY=VALUE pairs)
// + `authorized_keys` (one pubkey per line). well-firstboot.service
// (in the base image) mounts the labeled disk, sources the env, and
// applies identity. cloud-init is gone from the base image entirely.
//
// Why this matters: with cloud-init absent, the second boot (cidata
// detached for hibernate-legal steady state) doesn't block on
// datasource search and doesn't break ssh.socket activation. See
// docs/MVP-PLAN.md § B.0.9.d.4 for the design decision and the three
// parallel research agents (ASIF / Containerization / strip-cloud-init)
// that recommended this path on 2026-05-09.

import { spawn } from "bun";
import { copyFile, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WellSeedInput {
  hostname: string;
  // Default username for the well. well-firstboot.sh creates this
  // user, sets up sudo, and lays authorized_keys for them. Defaults
  // to "well" (matches cells team's birth-flow expectations).
  user?: string;
  // SSH public keys authorized for both ubuntu (cloud image's default)
  // and the well user. One per line in the seed file.
  authorizedKeys: string[];
  // Optional KEY=VALUE pairs for /etc/environment. PAM loads
  // /etc/environment on every session including SSH non-login.
  env?: Record<string, string>;
}

// Compose well.env content. The well-firstboot.sh script does
// `source /run/cidata/well.env` so this is bash-quoted KEY=VALUE.
// We always quote and escape — values may contain spaces, quotes, $.
export function composeWellEnv(input: WellSeedInput): string {
  const lines: string[] = [
    "# Wells per-well identity — sourced by /usr/local/sbin/well-firstboot.",
    "# Built by lib/wellSeed.ts at create time.",
    `WELL_HOSTNAME=${shellQuote(input.hostname)}`,
    `WELL_USER=${shellQuote(input.user ?? "well")}`,
  ];
  if (input.env) {
    for (const [k, v] of Object.entries(input.env)) {
      if (!isValidEnvKey(k)) {
        throw new Error(`invalid env key: ${k}`);
      }
      lines.push(`${k}=${shellQuote(v)}`);
    }
  }
  return lines.join("\n") + "\n";
}

// One key per line, no header — well-firstboot.sh just `install`s
// this file straight into authorized_keys.
export function composeAuthorizedKeys(keys: string[]): string {
  if (keys.length === 0) {
    throw new Error("at least one ssh authorized key required");
  }
  return keys.join("\n") + "\n";
}

// Build the seed disk to outputPath. The disk is ISO9660+Joliet with
// volume label "cidata" (well-firstboot.sh accepts both CIDATA and
// cidata casings as a defensive measure — hdiutil writes uppercase).
export async function buildWellSeed(
  input: WellSeedInput,
  outputPath: string,
): Promise<void> {
  if (input.hostname.length === 0) {
    throw new Error("hostname required");
  }
  const stage = await mkdtemp(join(tmpdir(), "well-seed-"));
  try {
    await writeFile(join(stage, "well.env"), composeWellEnv(input), {
      mode: 0o600,
    });
    await writeFile(
      join(stage, "authorized_keys"),
      composeAuthorizedKeys(input.authorizedKeys),
      { mode: 0o600 },
    );

    if (existsSync(outputPath)) {
      await unlink(outputPath);
    }
    const proc = spawn(
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
      throw new Error(`hdiutil makehybrid failed (${code}): ${err}`);
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

// Bash-style single-quote escape: wrap value in single quotes, replace
// internal single quotes with the standard '\''  trick. Safe for any
// value including those with $, `, \, ".
function shellQuote(value: string): string {
  if (value.includes("\n")) {
    throw new Error("env values cannot contain newlines");
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// /etc/environment-style: A-Z, 0-9, _; first char letter or _.
function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}
