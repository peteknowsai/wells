// Per-splite services. Translates a `ServiceDefinition` into a systemd unit
// inside the guest and persists the def under ~/.splites/services/<splite>/.
//
// Wire shape matches cells (`register-site-service.sh`): `{cmd, args, workdir}`.
// `env` (object) and `auto_restart` (default true) are optional extensions.
//
// On-guest layout:
//   /etc/systemd/system/splite-<id>.service  — the unit
//   /etc/splite/<id>.run                      — bash wrapper (avoids systemd quoting)
//   /etc/splite/<id>.env                      — Environment file (only when env is set)

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";

import { readDhcpLease } from "./dhcp.ts";
import { findSplite } from "./registry.ts";
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
  const envLine = hasEnvFile ? `EnvironmentFile=/etc/splite/${id}.env\n` : "";
  return [
    `[Unit]`,
    `Description=Splite service: ${id}`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `WorkingDirectory=${def.workdir}`,
    `User=ubuntu`,
    envLine.trimEnd(),
    `ExecStart=/etc/splite/${id}.run`,
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

interface ApplyArgs {
  splite: string;
  id: string;
  unit: string;
  run: string;
  env: string | null;
}

async function sshIntoGuest(splite: string, script: string): Promise<void> {
  const ip = await readDhcpLease(splite);
  if (!ip) throw new Error(`splite '${splite}' has no DHCP lease — start it first`);
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      "-o", "LogLevel=ERROR",
      "-i", PATHS.vmSshKey(splite),
      `ubuntu@${ip}`,
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
    ? `echo '${b64(env)}' | base64 -d | sudo tee /etc/splite/${id}.env > /dev/null && sudo chmod 0600 /etc/splite/${id}.env`
    : `sudo rm -f /etc/splite/${id}.env`;
  const script = `set -euo pipefail
sudo mkdir -p /etc/splite
echo '${b64(unit)}' | base64 -d | sudo tee /etc/systemd/system/splite-${id}.service > /dev/null
echo '${b64(run)}' | base64 -d | sudo tee /etc/splite/${id}.run > /dev/null
sudo chmod 0755 /etc/splite/${id}.run
${envCmd}
sudo systemctl daemon-reload
sudo systemctl enable --now splite-${id}
`;
  await sshIntoGuest(args.splite, script);
}

async function removeFromGuest(splite: string, id: string): Promise<void> {
  const script = `set -uo pipefail
sudo systemctl disable --now splite-${id} 2>/dev/null || true
sudo rm -f /etc/systemd/system/splite-${id}.service /etc/splite/${id}.run /etc/splite/${id}.env
sudo systemctl daemon-reload
`;
  await sshIntoGuest(splite, script);
}

interface PersistedService {
  id: string;
  splite: string;
  definition: ServiceDefinition;
  created_at: string;
}

async function readPersisted(splite: string, id: string): Promise<PersistedService | null> {
  try {
    const raw = await readFile(PATHS.serviceFile(splite, id), "utf-8");
    return JSON.parse(raw) as PersistedService;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function writePersisted(rec: PersistedService): Promise<void> {
  await mkdir(PATHS.spliteServicesDir(rec.splite), { recursive: true, mode: 0o700 });
  await writeFile(PATHS.serviceFile(rec.splite, rec.id), JSON.stringify(rec, null, 2));
}

export async function putService(
  splite: string,
  id: string,
  def: ServiceDefinition,
): Promise<ServiceResource> {
  validateServiceId(id);
  if (!(await findSplite(splite))) {
    throw new Error(`splite '${splite}' not found`);
  }

  const env = composeEnvFile(def.env);
  const run = composeRunScript(def);
  const unit = composeUnit(id, def, env !== null);

  await applyToGuest({ splite, id, unit, run, env });

  const existing = await readPersisted(splite, id);
  const rec: PersistedService = {
    id,
    splite,
    definition: def,
    created_at: existing?.created_at ?? new Date().toISOString(),
  };
  await writePersisted(rec);
  return rec;
}

export async function deleteService(splite: string, id: string): Promise<boolean> {
  validateServiceId(id);
  if (!(await findSplite(splite))) {
    throw new Error(`splite '${splite}' not found`);
  }
  const existing = await readPersisted(splite, id);
  // Best-effort guest cleanup even if the meta is missing — the caller
  // may be reconciling drift.
  await removeFromGuest(splite, id);
  if (existing) {
    await rm(PATHS.serviceFile(splite, id), { force: true });
  }
  return existing !== null;
}

export async function getService(splite: string, id: string): Promise<ServiceResource | null> {
  validateServiceId(id);
  return await readPersisted(splite, id);
}

export async function listServices(splite: string): Promise<ServiceResource[]> {
  let names: string[];
  try {
    names = await readdir(PATHS.spliteServicesDir(splite));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: ServiceResource[] = [];
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -".json".length);
    const rec = await readPersisted(splite, id);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
