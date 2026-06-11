// Per-well services. Translates a `ServiceDefinition` into a systemd unit
// inside the guest and persists the def under ~/.wells/services/<well>/.
//
// Wire shape matches cells (`register-site-service.sh`): `{cmd, args, workdir}`.
// `env` (object) and `auto_restart` (default true) are optional extensions.
//
// On-guest layout:
//   /etc/systemd/system/well-<id>.service  — the unit
//   /etc/well/<id>.run                      — bash wrapper (avoids systemd quoting)
//   /etc/well/<id>.env                      — Environment file (only when env is set)

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";

import { resolveWellIp } from "./dhcp.ts";
import { findWell } from "./registry.ts";
import { PATHS } from "./state.ts";
import type { ServiceDefinition, ServiceResource } from "./schemas.ts";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validateServiceId(id: string): void {
  if (!ID_RE.test(id)) {
    throw new Error(
      `service id '${id}' invalid (must match ${ID_RE} — letters/digits/_/- only)`,
    );
  }
}

// Compose the wrapper script. The script `exec`s the cmd+args after
// shell-escaping each arg, so systemd's own quoting never enters the
// picture. Returns text that ends with a newline.
export function composeRunScript(def: ServiceDefinition): string {
  const escaped = [def.cmd, ...def.args].map(shellQuote).join(" ");
  return `#!/usr/bin/env bash\nexec ${escaped}\n`;
}

// Compose the systemd unit. `Restart=always` when auto_restart is true
// (default true). When auto_restart is false, no Restart= directive.
export function composeUnit(id: string, def: ServiceDefinition, hasEnvFile: boolean): string {
  const restart = def.auto_restart === false ? "" : "Restart=always\nRestartSec=2\n";
  const envLine = hasEnvFile ? `EnvironmentFile=/etc/well/${id}.env\n` : "";
  // Default run-as is root: the VM is the sandbox (root-cell migration,
  // 2026-05-15), and the ubuntu user is on its way out of the base image —
  // a unit defaulting to a user that won't exist is a timebomb. Definitions
  // that want a different user say so explicitly.
  const user = def.user && def.user.length > 0 ? def.user : "root";
  if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) {
    throw new Error(`service user '${user}' invalid (POSIX-username shape required)`);
  }
  return [
    `[Unit]`,
    `Description=Well service: ${id}`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `WorkingDirectory=${def.workdir}`,
    `User=${user}`,
    envLine.trimEnd(),
    `ExecStart=/etc/well/${id}.run`,
    restart.trimEnd(),
    ``,
    `[Install]`,
    `WantedBy=multi-user.target`,
    ``,
  ]
    .filter((line) => line !== "")
    .join("\n")
    // Restore a single trailing newline.
    .concat("\n");
}

export function composeEnvFile(env: Record<string, string> | undefined): string | null {
  if (!env || Object.keys(env).length === 0) return null;
  return Object.entries(env)
    .map(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        throw new Error(`env key '${k}' invalid for systemd EnvironmentFile`);
      }
      // EnvironmentFile values: bash-style. Wrap in single quotes so
      // anything goes; embedded singles via the standard '\'' trick.
      return `${k}='${v.replaceAll("'", "'\\''")}'`;
    })
    .join("\n")
    .concat("\n");
}

// Conservative shell escape — bare-pass safe chars, single-quote everything else.
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_/.@:=+-]+$/.test(s) && s.length > 0) return s;
  return "'" + s.replaceAll("'", "'\\''") + "'";
}

export interface ApplyArgs {
  well: string;
  id: string;
  unit: string;
  run: string;
  env: string | null;
}

async function sshIntoGuest(well: string, script: string): Promise<void> {
  // resolveWellIp, not readDhcpLease: every well registers in
  // /var/db/dhcpd_leases under the shared base-image hostname, so a
  // hostname-only lookup always misses. resolveWellIp does pinned_ip →
  // MAC → hostname, which is why dhcp.ts's own doc says all call sites
  // must use it.
  const ip = await resolveWellIp(well);
  if (!ip) throw new Error(`well '${well}' has no resolvable IP — start it first`);
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      "-o", "LogLevel=ERROR",
      "-i", PATHS.vmSshKey(well),
      `root@${ip}`,
      "bash -s",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  proc.stdin.write(script);
  await proc.stdin.end();
  const [stderr, exit] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    throw new Error(`ssh apply failed (exit ${exit}): ${stderr.trim().slice(0, 500)}`);
  }
}

async function applyToGuest(args: ApplyArgs): Promise<void> {
  const { id, unit, run, env } = args;
  // Pass payloads via base64 so heredoc/quoting concerns vanish.
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
  const envCmd = env
    ? `echo '${b64(env)}' | base64 -d > /etc/well/${id}.env && chmod 0600 /etc/well/${id}.env`
    : `rm -f /etc/well/${id}.env`;
  const script = `set -euo pipefail
mkdir -p /etc/well
echo '${b64(unit)}' | base64 -d > /etc/systemd/system/well-${id}.service
echo '${b64(run)}' | base64 -d > /etc/well/${id}.run
chmod 0755 /etc/well/${id}.run
${envCmd}
systemctl daemon-reload
systemctl enable --now well-${id}
`;
  await sshIntoGuest(args.well, script);
}

async function removeFromGuest(well: string, id: string): Promise<void> {
  const script = `set -uo pipefail
systemctl disable --now well-${id} 2>/dev/null || true
rm -f /etc/systemd/system/well-${id}.service /etc/well/${id}.run /etc/well/${id}.env
systemctl daemon-reload
`;
  await sshIntoGuest(well, script);
}

interface PersistedService {
  id: string;
  well: string;
  definition: ServiceDefinition;
  created_at: string;
}

async function readPersisted(well: string, id: string): Promise<PersistedService | null> {
  try {
    const raw = await readFile(PATHS.serviceFile(well, id), "utf-8");
    return JSON.parse(raw) as PersistedService;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function writePersisted(rec: PersistedService): Promise<void> {
  await mkdir(PATHS.wellServicesDir(rec.well), { recursive: true, mode: 0o700 });
  await writeFile(PATHS.serviceFile(rec.well, rec.id), JSON.stringify(rec, null, 2));
}

export async function putService(
  well: string,
  id: string,
  def: ServiceDefinition,
): Promise<ServiceResource> {
  validateServiceId(id);
  if (!(await findWell(well))) {
    throw new Error(`well '${well}' not found`);
  }

  const env = composeEnvFile(def.env);
  const run = composeRunScript(def);
  const unit = composeUnit(id, def, env !== null);

  await applyToGuest({ well, id, unit, run, env });

  const existing = await readPersisted(well, id);
  const rec: PersistedService = {
    id,
    well,
    definition: def,
    created_at: existing?.created_at ?? new Date().toISOString(),
  };
  await writePersisted(rec);
  return rec;
}

export async function deleteService(well: string, id: string): Promise<boolean> {
  validateServiceId(id);
  if (!(await findWell(well))) {
    throw new Error(`well '${well}' not found`);
  }
  const existing = await readPersisted(well, id);
  // Best-effort guest cleanup even if the meta is missing — the caller
  // may be reconciling drift.
  await removeFromGuest(well, id);
  if (existing) {
    await rm(PATHS.serviceFile(well, id), { force: true });
  }
  return existing !== null;
}

export async function getService(well: string, id: string): Promise<ServiceResource | null> {
  validateServiceId(id);
  return await readPersisted(well, id);
}

export interface ServicesApplyResult {
  applied: string[];
  failed: { id: string; error: string }[];
}

// Converge the guest to every persisted def for this well. Defs are
// name-keyed declarations that survive destroy; a re-created well boots
// from a fresh base disk with no units, so create-time callers use this
// to close the def-vs-guest gap (mother's 18-day silent reply drop,
// cells incident review 2026-06-10). No defs → no SSH, no cost.
//
// Per-service failures are collected, not thrown — one poisoned def
// must not block the others (or the create that triggered the apply).
export async function applyPersistedServices(
  well: string,
  // Injectable for tests — same pattern as wake.ts's dedupedStart.
  applyFn: (args: ApplyArgs) => Promise<void> = applyToGuest,
): Promise<ServicesApplyResult> {
  const defs = await listServices(well);
  const result: ServicesApplyResult = { applied: [], failed: [] };
  for (const rec of defs) {
    try {
      const env = composeEnvFile(rec.definition.env);
      const run = composeRunScript(rec.definition);
      const unit = composeUnit(rec.id, rec.definition, env !== null);
      await applyFn({ well, id: rec.id, unit, run, env });
      result.applied.push(rec.id);
    } catch (e) {
      result.failed.push({ id: rec.id, error: (e as Error).message });
    }
  }
  return result;
}

export async function listServices(well: string): Promise<ServiceResource[]> {
  let names: string[];
  try {
    names = await readdir(PATHS.wellServicesDir(well));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: ServiceResource[] = [];
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -".json".length);
    const rec = await readPersisted(well, id);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
