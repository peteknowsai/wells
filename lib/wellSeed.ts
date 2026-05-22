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
  // SSH public keys authorized for root (the SSH entry user) + the
  // cloud image's ubuntu user. One per line in the seed file.
  authorizedKeys: string[];
  // Optional KEY=VALUE pairs for /etc/environment. PAM loads
  // /etc/environment on every session including SSH non-login.
  env?: Record<string, string>;
  // W.72: static IP. When set, well-firstboot.sh writes a static
  // netplan with this address and skips DHCP. When omitted, the
  // well boots with the base image's dhcp4:true netplan (legacy
  // path). Gateway + nameservers default to the vmnet bridge
  // (192.168.64.1) — overridable for non-default vmnet configs.
  staticIp?: {
    ip: string; // e.g. "192.168.64.215"
    cidrPrefix: number; // e.g. 24
    gateway?: string; // defaults to 192.168.64.1
    nameservers?: string[]; // defaults to [gateway]
  };
}

// Compose well.env content. The well-firstboot.sh script does
// `source /run/cidata/well.env` so this is bash-quoted KEY=VALUE.
// We always quote and escape — values may contain spaces, quotes, $.
export function composeWellEnv(input: WellSeedInput): string {
  const lines: string[] = [
    "# Wells per-well identity — sourced by /usr/local/sbin/well-firstboot.",
    "# Built by lib/wellSeed.ts at create time.",
    `WELL_HOSTNAME=${shellQuote(input.hostname)}`,
  ];
  if (input.staticIp) {
    if (!isValidIpv4(input.staticIp.ip)) {
      throw new Error(`invalid staticIp.ip: ${input.staticIp.ip}`);
    }
    if (
      !Number.isInteger(input.staticIp.cidrPrefix) ||
      input.staticIp.cidrPrefix < 1 ||
      input.staticIp.cidrPrefix > 31
    ) {
      throw new Error(`invalid staticIp.cidrPrefix: ${input.staticIp.cidrPrefix}`);
    }
    const gateway = input.staticIp.gateway ?? "192.168.64.1";
    if (!isValidIpv4(gateway)) {
      throw new Error(`invalid staticIp.gateway: ${gateway}`);
    }
    const dns = input.staticIp.nameservers ?? [gateway];
    for (const ns of dns) {
      if (!isValidIpv4(ns)) {
        throw new Error(`invalid staticIp.nameservers entry: ${ns}`);
      }
    }
    lines.push(
      `WELL_STATIC_IP_CIDR=${shellQuote(`${input.staticIp.ip}/${input.staticIp.cidrPrefix}`)}`,
      `WELL_GATEWAY=${shellQuote(gateway)}`,
      `WELL_NAMESERVERS=${shellQuote(dns.join(","))}`,
    );
  }
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

// Compose /etc/environment lines for the user's --env passthroughs.
// PAM reads /etc/environment on every session (including non-login
// SSH), so any KEY=VAL written here surfaces in the shell env when
// cells team's `well exec` lands. Format is the systemd-pam-env
// dialect — KEY=VALUE one per line, double-quoted to handle spaces;
// no shell expansion. We only emit the user's --env vars, not the
// wells-internal WELL_HOSTNAME. Returns empty string if
// no env passthrough was requested.
export function composeEtcEnvironment(input: WellSeedInput): string {
  if (!input.env) return "";
  const lines: string[] = [];
  for (const [k, v] of Object.entries(input.env)) {
    if (!isValidEnvKey(k)) {
      throw new Error(`invalid env key: ${k}`);
    }
    if (v.includes("\n")) {
      throw new Error("env values cannot contain newlines");
    }
    // Double-quote and escape \ and " so the value is preserved
    // literally — pam_env reads this verbatim, no expansion.
    const escaped = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push(`${k}="${escaped}"`);
  }
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
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
    const etcEnv = composeEtcEnvironment(input);
    if (etcEnv.length > 0) {
      await writeFile(join(stage, "etc-environment.append"), etcEnv, {
        mode: 0o600,
      });
    }
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

// Strict dotted-quad. The static-IP path goes straight into the guest's
// netplan, so a bad value here would break boot networking — fail loud
// at compose time instead.
function isValidIpv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^[0-9]{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}
