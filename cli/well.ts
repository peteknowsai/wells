#!/usr/bin/env bun
// Well CLI — thin client over welld's REST API. Mirrors sprites verbs.
//
// Engine ops (create, destroy, start, stop, checkpoint, list, info) all go
// through welld via HTTP; the daemon is the single writer of state.
// SSH plumbing (exec, console) reaches the well directly using the per-
// well ssh key in ~/.wells/vms/<n>/ — no point round-tripping through
// the daemon for that.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";
import { findWell } from "../lib/registry.ts";
import { readDhcpLease } from "../lib/dhcp.ts";
import { parseExecArgs } from "../lib/parseExecArgs.ts";
import { readWellPin } from "../lib/resolve.ts";
import { PATHS } from "../lib/state.ts";
import { readToken } from "../lib/token.ts";
import { ApiError, apiFetch } from "../lib/apiClient.ts";
import { shellEscape } from "../lib/shellEscape.ts";
import type {
  CheckpointResource,
  CheckpointsListResponse,
  DestroyResponse,
  ImageResource,
  ImagesListResponse,
  WellResource,
  WellsListResponse,
} from "../lib/schemas.ts";

const VERSION = "0.1.0-pre";

const HELP = `Usage: well <command> [options]

Well is the local sprite — a stateful Linux machine on hardware you own.

Commands:
  create <name>            Create a new well
  destroy [-s name]        Destroy a well (irreversible)
  rm [-s name]             Alias for destroy
  list                     List wells
  info [-s name]           Show well details
  use <name>               Pin the active well for cwd
  exec [-s name] [--user u] -- cmd
                           Run a command in a well (default user: well)
  console [-s name] [--user u]
                           Interactive shell (Ctrl+\\ to detach)
  start [-s name]          Boot a stopped well
  stop [-s name]           Stop a running well (filesystem persists)
  checkpoint <subcmd>      create | list | restore
  image <subcmd>           list | save <well> <name> | rm | info | push <name> | pull <name>
  url [subcmd]             Show URL or update auth mode
  auto-sleep --seconds N   Set per-well idle threshold (or --never)
  proxy <local>:<remote>   Forward a TCP port from this Mac to the well
  api [METHOD] <path>      Raw REST passthrough to welld
  doctor [--json]          One-shot health diagnostic (welld, lume, wells)

Global flags:
  -s, --well <name>      Target well (overrides .well in cwd)
  -v, --version            Print version
  -h, --help               Print this help

Env: WELL_API_URL (default http://127.0.0.1:7878), WELL_TOKEN.
`;

import { humanAge } from "./humanAge.ts";
import {
  defaultDoctorDeps,
  doctorExitCode,
  gatherDoctorReport,
  renderDoctorText,
} from "./doctor.ts";

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)}${units[i]}`;
}

export function parseFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const a = args.find((x) => x.startsWith(prefix));
  return a?.slice(prefix.length);
}

export function resolveName(args: string[], pin: string | undefined): string | undefined {
  const sIdx = args.findIndex((a) => a === "-s" || a === "--well");
  if (sIdx >= 0) return args[sIdx + 1];
  return pin;
}

function bail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await apiFetch<T>(method, path, body);
  } catch (e) {
    if (e instanceof ApiError) bail(`well: ${method} ${path} → ${e.status} ${e.errorCode}: ${e.message}`);
    bail(`well: ${(e as Error).message}`);
  }
}

async function cmdList(): Promise<void> {
  const r = await call<WellsListResponse>("GET", "/v1/wells");
  if (r.wells.length === 0) {
    console.log("no wells");
    return;
  }
  const rows = r.wells.map((s) => ({
    name: s.name,
    status: s.status,
    ip: s.ip ?? "—",
    age: humanAge(s.created_at),
  }));
  const w = (k: keyof (typeof rows)[number], min: number) =>
    Math.max(min, ...rows.map((r) => String(r[k]).length));
  const nameW = w("name", 4);
  const statusW = w("status", 6);
  const ipW = w("ip", 2);
  console.log(
    `${"NAME".padEnd(nameW)}  ${"STATUS".padEnd(statusW)}  ${"IP".padEnd(ipW)}  AGE`,
  );
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(nameW)}  ${r.status.padEnd(statusW)}  ${r.ip.padEnd(ipW)}  ${r.age}`,
    );
  }
}

async function cmdInfo(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("-"));
  const json = args.includes("--json");
  const name = positional[0] ?? (await readWellPin());
  if (!name) bail("usage: well info <name>  (or `well use <name>` to pin)");

  const r = await call<WellResource>("GET", `/v1/wells/${encodeURIComponent(name)}`);
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`name:     ${r.name}`);
  console.log(`status:   ${r.status}`);
  console.log(`ip:       ${r.ip ?? "—"}`);
  // `URL:` is uppercase by design — cells's deploy-cell-worker.sh pipes
  // this output to `awk '/^URL:/ {print $2}'`.
  console.log(`URL:      ${r.url ?? "—"}`);
  console.log(`cpu:      ${r.cpu} vCPU`);
  console.log(`memory:   ${r.memory}`);
  console.log(`disk:     ${r.disk_size} (used: ${r.disk_used_bytes != null ? fmtBytes(r.disk_used_bytes) : "—"})`);
  console.log(`created:  ${r.created_at} (${humanAge(r.created_at)} ago)`);
  console.log(`uuid:     ${r.uuid}`);
}

async function cmdUrl(args: string[]): Promise<void> {
  // `well url [name]`        → print public URL
  // `well url -s name`        → same, explicit pin
  // `well url update --auth=public|well -s name` → flip per-well auth
  if (args[0] === "update") return cmdUrlUpdate(args.slice(1));

  const sFlagIdx = args.indexOf("-s");
  const flagName = sFlagIdx >= 0 ? args[sFlagIdx + 1] : undefined;
  const positional = args.filter((a, i) =>
    !a.startsWith("-") && i !== sFlagIdx && (sFlagIdx < 0 || i !== sFlagIdx + 1),
  );
  const name = flagName ?? positional[0] ?? (await readWellPin());
  if (!name) bail("usage: well url [-s name]");
  const r = await call<WellResource>("GET", `/v1/wells/${encodeURIComponent(name)}`);
  if (r.url) {
    console.log(r.url);
  } else {
    console.error("no public URL — welld is not configured (set WELL_PUBLIC_BASE)");
    process.exit(1);
  }
}

async function cmdAutoSleep(args: string[]): Promise<void> {
  // Two modes:
  //   well auto-sleep --seconds <N> [-s name]
  //   well auto-sleep --never        [-s name]
  let value: number | null | undefined;
  if (args.includes("--never")) {
    value = null;
  } else {
    const eq = args.find((a) => a.startsWith("--seconds="));
    if (eq) value = Number(eq.slice("--seconds=".length));
    else {
      const i = args.indexOf("--seconds");
      if (i >= 0) value = Number(args[i + 1]);
    }
  }
  if (value === undefined || (value !== null && !Number.isFinite(value))) {
    bail("usage: well auto-sleep --seconds <N> | --never [-s name]");
  }
  const name = resolveName(args, await readWellPin());
  if (!name) bail("well auto-sleep: no well specified");
  const r = await call<WellResource>(
    "PATCH",
    `/v1/wells/${encodeURIComponent(name)}`,
    { auto_sleep_seconds: value },
  );
  if (value === null) console.log(`well '${r.name}' will never auto-sleep`);
  else console.log(`well '${r.name}' will auto-sleep after ${value}s idle`);
}

async function cmdUrlUpdate(args: string[]): Promise<void> {
  // Cells calls: `sprite url update --auth public -s <name>`. We accept
  // either `--auth public` (space-separated) or `--auth=public`.
  let auth: string | undefined;
  const eqArg = args.find((a) => a.startsWith("--auth="));
  if (eqArg) auth = eqArg.slice("--auth=".length);
  else {
    const i = args.indexOf("--auth");
    if (i >= 0) auth = args[i + 1];
  }
  if (auth !== "public" && auth !== "well") {
    bail("usage: well url update --auth=public|well [-s name]");
  }
  const name = resolveName(args, await readWellPin());
  if (!name) bail("well url update: no well specified");
  const r = await call<WellResource>(
    "PUT",
    `/v1/wells/${encodeURIComponent(name)}/url`,
    { auth },
  );
  console.log(`well '${r.name}' auth set to ${auth}`);
}

async function cmdCreate(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  if (!name) {
    bail(
      "usage: well create <name> [--cpu=N] [--memory=NGB] [--disk=NGB] " +
        "[--from-image=NAME | --from-thaw=SRC] [--env KEY=VALUE]... " +
        "[--r2-endpoint=URL --r2-bucket=NAME --r2-key=ID --r2-secret=KEY]",
    );
  }
  const cpuRaw = parseFlag(args, "cpu");
  const memory = parseFlag(args, "memory");
  const disk = parseFlag(args, "disk");
  const fromImage = parseFlag(args, "from-image");
  const fromThaw = parseFlag(args, "from-thaw");
  if (fromImage && fromThaw) {
    bail("well create: --from-image and --from-thaw are mutually exclusive");
  }
  const cpu = cpuRaw ? parseInt(cpuRaw, 10) : undefined;
  if (cpuRaw && (!Number.isFinite(cpu) || cpu! <= 0)) bail(`invalid --cpu='${cpuRaw}'`);

  // --env KEY=VAL (repeatable). Lands in /etc/environment via cloud-init.
  // Cells uses this for CELLS_PROXY_SECRET so the secret is present from
  // first boot — saves a post-birth round-trip via configure-cell-proxy.sh.
  const env: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a !== "--env") continue;
    const pair = args[i + 1];
    if (!pair) bail("--env needs a KEY=VALUE argument");
    const eq = pair.indexOf("=");
    if (eq <= 0) bail(`--env: expected KEY=VALUE, got '${pair}'`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
    i++;
  }

  // R2 cold-tier sync (Phase A.2). All four flags must land together; a
  // partial set is a usage error. Daemon validates again server-side.
  const r2Endpoint = parseFlag(args, "r2-endpoint");
  const r2Bucket = parseFlag(args, "r2-bucket");
  const r2Key = parseFlag(args, "r2-key");
  const r2Secret = parseFlag(args, "r2-secret");
  const r2Provided = [r2Endpoint, r2Bucket, r2Key, r2Secret].filter(Boolean).length;
  if (r2Provided > 0 && r2Provided < 4) {
    bail("well create: --r2-endpoint, --r2-bucket, --r2-key, --r2-secret must all be set together");
  }

  const provenance = fromThaw
    ? ` (thawed from '${fromThaw}')`
    : fromImage
      ? ` (from image '${fromImage}')`
      : "";
  console.log(`creating well '${name}'${provenance}…`);
  const body: Record<string, unknown> = { name };
  if (cpu !== undefined) body.cpu = cpu;
  if (memory !== undefined) body.memory = memory;
  if (disk !== undefined) body.disk = disk;
  if (fromImage !== undefined) body.from_image = fromImage;
  if (fromThaw !== undefined) body.from_thaw = fromThaw;
  if (Object.keys(env).length > 0) body.env = env;
  if (r2Provided === 4) {
    body.r2 = {
      endpoint: r2Endpoint,
      bucket: r2Bucket,
      access_key_id: r2Key,
      secret_access_key: r2Secret,
    };
  }
  const r = await call<WellResource>("POST", "/v1/wells", body);
  console.log(
    `well '${r.name}' created — ${r.ip ?? "(no ip)"} (${r.cpu} vCPU / ${r.memory} / ${r.disk_size})`,
  );
}

async function cmdDestroy(args: string[]): Promise<void> {
  // Sprites parity: cells calls `sprite destroy <n> --force`. We accept
  // both flags; pick whichever comes naturally.
  if (!args.includes("--yes") && !args.includes("--force")) {
    bail("well destroy: refusing without --yes/--force (this is irreversible)");
  }
  let name: string | undefined;
  const sIdx = args.findIndex((a) => a === "-s" || a === "--well");
  if (sIdx >= 0) name = args[sIdx + 1];
  if (!name) name = args.find((a) => !a.startsWith("-") && a !== "yes");
  if (!name) name = await readWellPin();
  if (!name) bail("usage: well destroy <name> --yes  |  well destroy -s <name> --force");

  console.log(`destroying ${name}…`);
  const r = await call<DestroyResponse>("DELETE", `/v1/wells/${encodeURIComponent(name)}`);
  if (!r.found) {
    console.log(`well '${name}' not found — nothing to do`);
    return;
  }
  console.log(`well '${name}' destroyed`);
}

async function cmdStart(args: string[]): Promise<void> {
  const name = resolveName(args, await readWellPin());
  if (!name) bail("usage: well start [-s name]");
  console.log(`starting ${name}…`);
  const r = await call<WellResource>("POST", `/v1/wells/${encodeURIComponent(name)}/start`);
  console.log(`well '${r.name}' ${r.status}${r.ip ? ` @ ${r.ip}` : ""}`);
}

async function cmdStop(args: string[]): Promise<void> {
  const name = resolveName(args, await readWellPin());
  if (!name) bail("usage: well stop [-s name]");
  const r = await call<WellResource>("POST", `/v1/wells/${encodeURIComponent(name)}/stop`);
  console.log(`well '${r.name}' ${r.status}`);
}

async function cmdCheckpoint(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "create":  return cmdCheckpointCreate(rest);
    case "list":    return cmdCheckpointList(rest);
    case "restore": return cmdCheckpointRestore(rest);
    case "expire":  return cmdCheckpointExpire(rest);
    default:
      bail("usage: well checkpoint <create|list|restore|expire> [args]");
  }
}

async function cmdCheckpointCreate(args: string[]): Promise<void> {
  const name = resolveName(args, await readWellPin());
  if (!name) {
    bail("usage: well checkpoint create [-s name] [--comment <label>] [--retain-for <duration>]");
  }
  // Accept --comment either space-separated or =joined.
  let comment: string | undefined;
  const eq = args.find((a) => a.startsWith("--comment="));
  if (eq) comment = eq.slice("--comment=".length);
  else {
    const i = args.indexOf("--comment");
    if (i >= 0) comment = args[i + 1];
  }
  const retainFor = parseFlag(args, "retain-for");
  const body: Record<string, unknown> = {};
  if (comment) body.comment = comment;
  if (retainFor) body.retain_for = retainFor;
  const t0 = Date.now();
  const cp = await call<CheckpointResource>(
    "POST",
    `/v1/wells/${encodeURIComponent(name)}/checkpoints`,
    Object.keys(body).length > 0 ? body : undefined,
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  const label = cp.comment ? ` "${cp.comment}"` : "";
  const ttl = cp.expires_at ? ` (expires ${cp.expires_at})` : "";
  console.log(
    `checkpoint '${cp.id}'${label} created (${elapsed}s, ${fmtBytes(cp.size_bytes)})${ttl}`,
  );
}

async function cmdCheckpointExpire(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("-"));
  const id = positional[0];
  if (!id) bail("usage: well checkpoint expire <id> [-s name]");
  const name = resolveName(args, await readWellPin());
  if (!name) bail("well checkpoint expire: no well specified");
  const r = await call<{ removed: boolean; id: string }>(
    "DELETE",
    `/v1/wells/${encodeURIComponent(name)}/checkpoints/${encodeURIComponent(id)}`,
  );
  if (r.removed) console.log(`checkpoint '${id}' removed`);
  else console.log(`checkpoint '${id}' not found — nothing to do`);
}

async function cmdCheckpointList(args: string[]): Promise<void> {
  const name = resolveName(args, await readWellPin());
  if (!name) bail("usage: well checkpoint list [-s name]");
  const r = await call<CheckpointsListResponse>(
    "GET",
    `/v1/wells/${encodeURIComponent(name)}/checkpoints`,
  );
  if (r.checkpoints.length === 0) {
    console.log(`no checkpoints for ${name}`);
    return;
  }
  const idW = Math.max(2, ...r.checkpoints.map((c) => c.id.length));
  const ageW = 6;
  const hasComments = r.checkpoints.some((c) => c.comment);
  console.log(
    `${"ID".padEnd(idW)}  ${"AGE".padEnd(ageW)}  CREATED                    SIZE      DELTA${hasComments ? "     COMMENT" : ""}`,
  );
  for (const c of r.checkpoints) {
    const tail = hasComments ? `  ${c.comment ?? ""}` : "";
    console.log(
      `${c.id.padEnd(idW)}  ${humanAge(c.created_at).padEnd(ageW)}  ${c.created_at}  ${fmtBytes(c.size_bytes).padEnd(8)}  ${fmtBytes(c.physical_bytes)}${tail}`,
    );
  }
}

async function cmdCheckpointRestore(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("-"));
  const id = positional[0];
  if (!id) bail("usage: well checkpoint restore <id> [-s name] [--from-r2]");
  const name = resolveName(args, await readWellPin());
  if (!name) bail("well checkpoint restore: no well specified");
  const fromR2 = args.includes("--from-r2");
  console.log(
    `restoring '${name}' to checkpoint '${id}'${fromR2 ? " (from R2)" : ""}…`,
  );
  const t0 = Date.now();
  const path = `/v1/wells/${encodeURIComponent(name)}/checkpoints/${encodeURIComponent(id)}/restore${fromR2 ? "?from_r2=true" : ""}`;
  const r = await call<WellResource>("POST", path);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`restored — ${r.status}${r.ip ? ` @ ${r.ip}` : ""} (${elapsed}s)`);
}

async function cmdConsole(args: string[]): Promise<void> {
  // `--user <user>` overrides the default agent user. Use --user ubuntu
  // for raw-VM access during debug.
  let user = "well";
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-u" || a === "--user") {
      user = args[++i] ?? bail(`${a} requires a value`) as never;
    } else {
      filtered.push(a);
    }
  }
  const name = resolveName(filtered, await readWellPin());
  if (!name) bail("usage: well console [-s name] [--user <user>]");
  const record = await findWell(name);
  if (!record) bail(`well '${name}' not found in registry`);
  const ip = await readDhcpLease(name);
  if (!ip) bail(`well '${name}' has no DHCP lease — is it running?`);

  console.error(
    `connecting to ${user}@${ip} (${name}) — escape: Ctrl+\\ then '.' to detach`,
  );
  // Same SSH-as-well-then-sudo-switch pattern as cmdExec (handles
  // users not set up for SSH — e.g. cells team's `cell` user).
  const sshArgs = [
    "ssh", "-t", "-e", String.fromCharCode(0x1c),
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-i", PATHS.vmSshKey(name),
    `well@${ip}`,
  ];
  if (user !== "well") {
    sshArgs.push(`sudo -n -u ${shellEscape(user)} -i`);
  }
  const proc = spawn(sshArgs, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
}

async function cmdExec(args: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseExecArgs(args);
  } catch (e) {
    console.error(`well exec: ${(e as Error).message}`);
    bail("usage: well exec [-s name] [--tty] -- <cmd> [args]");
  }
  const name = parsed.well ?? (await readWellPin());
  if (!name) bail("well exec: no well specified (use -s or `well use <name>`)");
  const record = await findWell(name);
  if (!record) bail(`well '${name}' not found in registry`);
  // Wake-on-demand. Wells auto-sleep after idle, so a stopped well or a
  // paused one needs to come up before SSH. POST /start is idempotent
  // (returns immediately if already running) and waits for a DHCP lease,
  // so by the time it returns, the IP in the response is dialable.
  // Without this, exec races the wake and ssh hangs on connect.
  const started = await call<WellResource>(
    "POST",
    `/v1/wells/${encodeURIComponent(name)}/start`,
  );
  const ip = started.ip ?? (await readDhcpLease(name));
  if (!ip) bail(`well '${name}' has no IP after start — check welld logs`);

  // Default to the `well` agent user; --user overrides for raw-VM
  // access. SSH always lands as `well` (the only firstboot-set-up user
  // beyond `ubuntu`), and we sudo-switch when --user names something
  // else — so cells's `cell` user (created during their bake, no SSH
  // setup) is reachable via `well exec --user=cell` without their
  // prior client-side sudo wrap.
  const user = parsed.user ?? "well";
  // Shell-escape each cmd arg and join — passing them as separate ssh
  // post-host args is broken (ssh joins with spaces and the remote shell
  // re-parses metacharacters). Same fix as the daemon's WS handler.
  const innerCmd = parsed.cmd.map(shellEscape).join(" ");
  const remoteCmd =
    user === "well"
      ? innerCmd
      : `sudo -n -u ${shellEscape(user)} bash -c ${shellEscape(innerCmd)}`;
  const sshArgs = [
    "ssh",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-i", PATHS.vmSshKey(name),
    ...(parsed.tty ? ["-t"] : []),
    `well@${ip}`,
    remoteCmd,
  ];

  const proc = spawn(sshArgs, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exit(await proc.exited);
}

async function cmdUse(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) bail("usage: well use <name>");
  // Ask welld (not the registry directly) so the user gets a meaningful
  // error if the daemon isn't reachable — same failure mode as everything else.
  await call<WellResource>("GET", `/v1/wells/${encodeURIComponent(name)}`);
  const path = join(process.cwd(), ".well");
  await writeFile(path, JSON.stringify({ well: name }) + "\n");
  console.log(`pinned ${name} → ${path}`);
}

async function cmdApi(args: string[]): Promise<void> {
  // Raw passthrough. Accepts curl-flavored flags so cells's sprite-tools
  // can call us verbatim:
  //   sprite api -s <n> /v1/sprites/<n>/foo -X POST -H 'Content-Type: ...' -d <body>
  // We tolerate -s/-H as no-ops (path alias on the daemon handles the
  // sprites→wells noun rewrite, and we set Content-Type ourselves when
  // a body is present). -X overrides the method.
  let method: string | undefined;
  let bodyArg: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-s" || a === "--well") { i++; continue; }
    if (a === "-H" || a === "--header") { i++; continue; }
    if (a === "-X" || a === "--request") { method = args[++i]?.toUpperCase(); continue; }
    if (a === "-d" || a === "--data") { bodyArg = args[++i]; continue; }
    positional.push(a);
  }

  let path: string | undefined;
  if (positional.length === 1) path = positional[0];
  else if (positional.length === 2) { method = method ?? positional[0]!.toUpperCase(); path = positional[1]; }
  else bail("usage: well api [METHOD] <path> [-d <json>|-] [-X METHOD] [-H header]");
  if (!path || !path.startsWith("/")) bail("well api: path must start with '/'");
  method = method ?? "GET";

  const token = process.env.WELL_TOKEN ?? (await readToken());
  if (!token) bail("well api: no token (set WELL_TOKEN or run welld once)");
  const baseUrl = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";

  let body: string | undefined;
  if (bodyArg === "-") body = await Bun.stdin.text();
  else if (bodyArg !== undefined) body = bodyArg;

  let r: Response;
  try {
    r = await fetch(baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body,
    });
  } catch (e) {
    console.error(`well api: cannot reach ${baseUrl} — is welld running?`);
    bail(`  ${(e as Error).message}`);
  }
  const text = await r.text();
  if (text.length > 0) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  if (!r.ok) bail(`well api: ${method} ${path} → ${r.status}`);
}

type Handler = (args: string[]) => void | Promise<void>;

function notImplemented(verb: string, phase: number): Handler {
  return () => {
    console.error(`well ${verb}: not implemented (lands in phase ${phase})`);
    process.exit(2);
  };
}

async function cmdDoctor(args: string[]): Promise<void> {
  // One-shot diagnostic for triaging "is wells healthy right now?". Hits
  // /healthz, lists wells, checks lume reachability + dangling subprocesses.
  // Exits 0 healthy / 1 unhealthy / 2 degraded for automation. --json
  // returns the structured DoctorReport for machine-readable consumption.
  const json = args.includes("--json");
  const baseUrl = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
  const deps = defaultDoctorDeps(baseUrl, async () => {
    const r = await call<WellsListResponse>("GET", "/v1/wells");
    return r.wells.map((w) => ({
      name: w.name,
      status: w.status,
      ip: w.ip ?? null,
    }));
  });
  const report = await gatherDoctorReport(deps);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderDoctorText(report));
  }
  process.exit(doctorExitCode(report.result));
}

async function cmdImage(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":  return cmdImageList(rest);
    case "ls":    return cmdImageList(rest);
    case "save":  return cmdImageSave(rest);
    case "rm":    return cmdImageRm(rest);
    case "info":  return cmdImageInfo(rest);
    case "push":  return cmdImagePush(rest);
    case "pull":  return cmdImagePull(rest);
    default:
      bail(
        "usage: well image (list | save <well> <image-name> [--notes=…] | rm <name> | info <name> | push <name> | pull <name>)",
      );
  }
}

// W.4 — push a local image to the R2 library. Welld picks up R2 creds
// from WELL_R2_LIBRARY_* env on its end; CLI doesn't ferry them.
async function cmdImagePush(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  if (!name) bail("usage: well image push <name>");
  console.log(`pushing image '${name}' to R2 library…`);
  const r = await call<{
    manifest: {
      name: string;
      disk_sha256: string;
      disk_size_bytes: number;
      pushed_at: string;
    };
    keys: { manifest: string; meta: string; disk: string };
    durationMs: number;
  }>("POST", `/v1/wells/images/${encodeURIComponent(name)}/push`);
  console.log(
    `image '${r.manifest.name}' pushed (${fmtBytes(r.manifest.disk_size_bytes)}, sha256 ${r.manifest.disk_sha256.slice(0, 12)}…, ${r.durationMs}ms)`,
  );
  console.log(`  → ${r.keys.disk}`);
}

// W.5 — pull an image from the R2 library to local. Default behavior:
// refuse if local already exists; --force overrides.
async function cmdImagePull(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  if (!name) bail("usage: well image pull <name> [--force]");
  // Local-exists check happens server-side via imageExists; CLI just
  // surfaces the friendly behavior. --force = re-pull anyway. The
  // server's pullImage always overwrites; the gate is here.
  const force = args.includes("--force");
  if (!force) {
    try {
      await call("GET", `/v1/wells/images/${encodeURIComponent(name)}`);
      console.log(
        `image '${name}' already exists locally — use --force to re-pull`,
      );
      return;
    } catch {
      // 404 = not local = good, proceed with pull
    }
  }
  console.log(`pulling image '${name}' from R2 library…`);
  const r = await call<{
    manifest: {
      name: string;
      disk_sha256: string;
      disk_size_bytes: number;
      pushed_at: string;
    };
    bytes: number;
    durationMs: number;
  }>("POST", `/v1/wells/images/${encodeURIComponent(name)}/pull`);
  console.log(
    `image '${r.manifest.name}' pulled (${fmtBytes(r.bytes)}, sha256 ${r.manifest.disk_sha256.slice(0, 12)}…, ${r.durationMs}ms)`,
  );
}

async function cmdImageList(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const r = await call<ImagesListResponse>("GET", "/v1/wells/images");
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (r.images.length === 0) {
    console.log("no images");
    return;
  }
  const rows = r.images.map((i) => ({
    name: i.name,
    from: i.from_well ?? "—",
    size: i.size_bytes != null ? fmtBytes(i.size_bytes) : "—",
    age: i.created_at === "unknown" ? "—" : humanAge(i.created_at),
  }));
  const w = (k: keyof (typeof rows)[number], min: number) =>
    Math.max(min, ...rows.map((r) => String(r[k]).length));
  const nameW = w("name", 4);
  const fromW = w("from", 4);
  const sizeW = w("size", 4);
  console.log(
    `${"NAME".padEnd(nameW)}  ${"FROM".padEnd(fromW)}  ${"SIZE".padEnd(sizeW)}  AGE`,
  );
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(nameW)}  ${r.from.padEnd(fromW)}  ${r.size.padEnd(sizeW)}  ${r.age}`,
    );
  }
}

async function cmdImageSave(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const fromWell = positional[0];
  const imageName = positional[1];
  if (!fromWell || !imageName) {
    bail("usage: well image save <well> <image-name> [--notes=…] [--validate]");
  }
  const notes = parseFlag(args, "notes");
  // --validate: source must be running; welld SSHes in to verify
  // /etc/netplan + cloud-init state before stopping + cloning. Catches
  // the class of broken-source-image bug that bit the cells team.
  const validate = args.includes("--validate");
  console.log(
    `saving image '${imageName}' from well '${fromWell}'${validate ? " (with --validate)" : ""}…`,
  );
  const body: Record<string, unknown> = {
    name: imageName,
    from_well: fromWell,
  };
  if (notes !== undefined) body.notes = notes;
  if (validate) body.validate = true;
  const r = await call<ImageResource>("POST", "/v1/wells/images", body);
  console.log(
    `image '${r.name}' saved${r.size_bytes != null ? ` (${fmtBytes(r.size_bytes)})` : ""}`,
  );
}

async function cmdImageRm(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  if (!name) bail("usage: well image rm <name>");
  const r = await call<{ name: string; removed: boolean }>(
    "DELETE",
    `/v1/wells/images/${encodeURIComponent(name)}`,
  );
  if (!r.removed) {
    console.log(`image '${name}' not found — nothing to do`);
    return;
  }
  console.log(`image '${name}' removed`);
}

async function cmdImageInfo(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const json = args.includes("--json");
  const name = positional[0];
  if (!name) bail("usage: well image info <name>");
  const r = await call<ImageResource>(
    "GET",
    `/v1/wells/images/${encodeURIComponent(name)}`,
  );
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`name:      ${r.name}`);
  console.log(`from:      ${r.from_well ?? "(prebuilt)"}`);
  console.log(`disk:      ${r.from_disk_size ?? "—"}${r.size_bytes != null ? ` (${fmtBytes(r.size_bytes)} on disk)` : ""}`);
  console.log(`created:   ${r.created_at}${r.created_at !== "unknown" ? ` (${humanAge(r.created_at)} ago)` : ""}`);
  if (r.notes) console.log(`notes:     ${r.notes}`);
}

const COMMANDS: Record<string, Handler> = {
  create:     cmdCreate,
  destroy:    cmdDestroy,
  rm:         cmdDestroy,
  list:       cmdList,
  info:       cmdInfo,
  use:        cmdUse,
  exec:       cmdExec,
  console:    cmdConsole,
  start:      cmdStart,
  stop:       cmdStop,
  checkpoint: cmdCheckpoint,
  image:      cmdImage,
  // Sprites parity: cells calls `sprite restore <id> -s <n>` as a top-level
  // verb. Well's canonical form is nested (`well checkpoint restore`).
  // Both work; flat is the cells-shaped alias.
  restore:    cmdCheckpointRestore,
  url:        cmdUrl,
  "auto-sleep": cmdAutoSleep,
  proxy:      notImplemented("proxy", 9),
  api:        cmdApi,
  doctor:     cmdDoctor,
};

// Top-level CLI dispatch. Guarded by import.meta.main so the file's
// exported helpers can be imported (e.g. by tests) without running the
// CLI as a side effect.
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help" || args[0] === "help") {
    console.log(HELP);
    process.exit(0);
  }

  if (args[0] === "-v" || args[0] === "--version") {
    console.log(VERSION);
    process.exit(0);
  }

  const verb = args[0]!;
  const handler = COMMANDS[verb];
  if (!handler) {
    console.error(`well: unknown command '${verb}'. Run 'well --help' for usage.`);
    process.exit(64);
  }

  await handler(args.slice(1));
}
