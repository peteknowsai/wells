#!/usr/bin/env bun
// Splite CLI — thin client over splited's REST API. Mirrors sprites verbs.
//
// Engine ops (create, destroy, start, stop, checkpoint, list, info) all go
// through splited via HTTP; the daemon is the single writer of state.
// SSH plumbing (exec, console) reaches the splite directly using the per-
// splite ssh key in ~/.splites/vms/<n>/ — no point round-tripping through
// the daemon for that.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";
import { findSplite } from "../lib/registry.ts";
import { readDhcpLease } from "../lib/dhcp.ts";
import { parseExecArgs } from "../lib/parseExecArgs.ts";
import { readSplitePin } from "../lib/resolve.ts";
import { PATHS } from "../lib/state.ts";
import { readToken } from "../lib/token.ts";
import { ApiError, apiFetch } from "../lib/apiClient.ts";
import type {
  CheckpointResource,
  CheckpointsListResponse,
  DestroyResponse,
  SpliteResource,
  SplitesListResponse,
} from "../lib/schemas.ts";

const VERSION = "0.1.0-pre";

const HELP = `Usage: splite <command> [options]

Splite is the local sprite — a stateful Linux machine on hardware you own.

Commands:
  create <name>            Create a new splite
  destroy [-s name]        Destroy a splite (irreversible)
  rm [-s name]             Alias for destroy
  list                     List splites
  info [-s name]           Show splite details
  use <name>               Pin the active splite for cwd
  exec [-s name] -- cmd    Run a command in a splite
  console [-s name]        Interactive shell (Ctrl+\\ to detach)
  start [-s name]          Boot a stopped splite
  stop [-s name]           Stop a running splite (filesystem persists)
  checkpoint <subcmd>      create | list | restore
  url [subcmd]             Show URL or update auth mode
  proxy <local>:<remote>   Forward a TCP port from this Mac to the splite
  api [METHOD] <path>      Raw REST passthrough to splited

Global flags:
  -s, --splite <name>      Target splite (overrides .splite in cwd)
  -v, --version            Print version
  -h, --help               Print this help

Env: SPLITES_API_URL (default http://127.0.0.1:7878), SPLITES_TOKEN.
`;

function humanAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)}${units[i]}`;
}

function parseFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const a = args.find((x) => x.startsWith(prefix));
  return a?.slice(prefix.length);
}

function resolveName(args: string[], pin: string | undefined): string | undefined {
  const sIdx = args.findIndex((a) => a === "-s" || a === "--splite");
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
    if (e instanceof ApiError) bail(`splite: ${method} ${path} → ${e.status} ${e.errorCode}: ${e.message}`);
    bail(`splite: ${(e as Error).message}`);
  }
}

async function cmdList(): Promise<void> {
  const r = await call<SplitesListResponse>("GET", "/v1/splites");
  if (r.splites.length === 0) {
    console.log("no splites");
    return;
  }
  const rows = r.splites.map((s) => ({
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
  const name = positional[0] ?? (await readSplitePin());
  if (!name) bail("usage: splite info <name>  (or `splite use <name>` to pin)");

  const r = await call<SpliteResource>("GET", `/v1/splites/${encodeURIComponent(name)}`);
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`name:     ${r.name}`);
  console.log(`status:   ${r.status}`);
  console.log(`ip:       ${r.ip ?? "—"}`);
  console.log(`url:      ${r.url ?? "—"}`);
  console.log(`cpu:      ${r.cpu} vCPU`);
  console.log(`memory:   ${r.memory}`);
  console.log(`disk:     ${r.disk_size} (used: ${r.disk_used_bytes != null ? fmtBytes(r.disk_used_bytes) : "—"})`);
  console.log(`created:  ${r.created_at} (${humanAge(r.created_at)} ago)`);
  console.log(`uuid:     ${r.uuid}`);
}

async function cmdUrl(args: string[]): Promise<void> {
  // `splite url [name]`  → prints the public URL or errors if not configured.
  // `splite url -s name` → same with explicit pin.
  const sFlagIdx = args.indexOf("-s");
  const flagName = sFlagIdx >= 0 ? args[sFlagIdx + 1] : undefined;
  const positional = args.filter((a, i) =>
    !a.startsWith("-") && i !== sFlagIdx && (sFlagIdx < 0 || i !== sFlagIdx + 1),
  );
  const name = flagName ?? positional[0] ?? (await readSplitePin());
  if (!name) bail("usage: splite url [-s name]");
  const r = await call<SpliteResource>("GET", `/v1/splites/${encodeURIComponent(name)}`);
  if (r.url) {
    console.log(r.url);
  } else {
    console.error("no public URL — splited is not configured (set SPLITES_PUBLIC_BASE)");
    process.exit(1);
  }
}

async function cmdCreate(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  if (!name) bail("usage: splite create <name> [--cpu=N] [--memory=NGB] [--disk=NGB]");
  const cpuRaw = parseFlag(args, "cpu");
  const memory = parseFlag(args, "memory");
  const disk = parseFlag(args, "disk");
  const cpu = cpuRaw ? parseInt(cpuRaw, 10) : undefined;
  if (cpuRaw && (!Number.isFinite(cpu) || cpu! <= 0)) bail(`invalid --cpu='${cpuRaw}'`);

  console.log(`creating splite '${name}'…`);
  const body: Record<string, unknown> = { name };
  if (cpu !== undefined) body.cpu = cpu;
  if (memory !== undefined) body.memory = memory;
  if (disk !== undefined) body.disk = disk;
  const r = await call<SpliteResource>("POST", "/v1/splites", body);
  console.log(
    `splite '${r.name}' created — ${r.ip ?? "(no ip)"} (${r.cpu} vCPU / ${r.memory} / ${r.disk_size})`,
  );
}

async function cmdDestroy(args: string[]): Promise<void> {
  if (!args.includes("--yes")) bail("splite destroy: refusing without --yes (this is irreversible)");
  let name: string | undefined;
  const sIdx = args.findIndex((a) => a === "-s" || a === "--splite");
  if (sIdx >= 0) name = args[sIdx + 1];
  if (!name) name = args.find((a) => !a.startsWith("-") && a !== "yes");
  if (!name) name = await readSplitePin();
  if (!name) bail("usage: splite destroy <name> --yes  |  splite destroy -s <name> --yes");

  console.log(`destroying ${name}…`);
  const r = await call<DestroyResponse>("DELETE", `/v1/splites/${encodeURIComponent(name)}`);
  if (!r.found) {
    console.log(`splite '${name}' not found — nothing to do`);
    return;
  }
  console.log(`splite '${name}' destroyed`);
}

async function cmdStart(args: string[]): Promise<void> {
  const name = resolveName(args, await readSplitePin());
  if (!name) bail("usage: splite start [-s name]");
  console.log(`starting ${name}…`);
  const r = await call<SpliteResource>("POST", `/v1/splites/${encodeURIComponent(name)}/start`);
  console.log(`splite '${r.name}' ${r.status}${r.ip ? ` @ ${r.ip}` : ""}`);
}

async function cmdStop(args: string[]): Promise<void> {
  const name = resolveName(args, await readSplitePin());
  if (!name) bail("usage: splite stop [-s name]");
  const r = await call<SpliteResource>("POST", `/v1/splites/${encodeURIComponent(name)}/stop`);
  console.log(`splite '${r.name}' ${r.status}`);
}

async function cmdCheckpoint(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "create":  return cmdCheckpointCreate(rest);
    case "list":    return cmdCheckpointList(rest);
    case "restore": return cmdCheckpointRestore(rest);
    default: bail("usage: splite checkpoint <create|list|restore> [args]");
  }
}

async function cmdCheckpointCreate(args: string[]): Promise<void> {
  const name = resolveName(args, await readSplitePin());
  if (!name) bail("usage: splite checkpoint create [-s name]");
  const t0 = Date.now();
  const cp = await call<CheckpointResource>(
    "POST",
    `/v1/splites/${encodeURIComponent(name)}/checkpoints`,
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`checkpoint '${cp.id}' created (${elapsed}s, ${fmtBytes(cp.size_bytes)})`);
}

async function cmdCheckpointList(args: string[]): Promise<void> {
  const name = resolveName(args, await readSplitePin());
  if (!name) bail("usage: splite checkpoint list [-s name]");
  const r = await call<CheckpointsListResponse>(
    "GET",
    `/v1/splites/${encodeURIComponent(name)}/checkpoints`,
  );
  if (r.checkpoints.length === 0) {
    console.log(`no checkpoints for ${name}`);
    return;
  }
  const idW = Math.max(2, ...r.checkpoints.map((c) => c.id.length));
  const ageW = 6;
  console.log(
    `${"ID".padEnd(idW)}  ${"AGE".padEnd(ageW)}  CREATED                    SIZE      DELTA`,
  );
  for (const c of r.checkpoints) {
    console.log(
      `${c.id.padEnd(idW)}  ${humanAge(c.created_at).padEnd(ageW)}  ${c.created_at}  ${fmtBytes(c.size_bytes).padEnd(8)}  ${fmtBytes(c.physical_bytes)}`,
    );
  }
}

async function cmdCheckpointRestore(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("-"));
  const id = positional[0];
  if (!id) bail("usage: splite checkpoint restore <id> [-s name]");
  const name = resolveName(args, await readSplitePin());
  if (!name) bail("splite checkpoint restore: no splite specified");
  console.log(`restoring '${name}' to checkpoint '${id}'…`);
  const t0 = Date.now();
  const r = await call<SpliteResource>(
    "POST",
    `/v1/splites/${encodeURIComponent(name)}/checkpoints/${encodeURIComponent(id)}/restore`,
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`restored — ${r.status}${r.ip ? ` @ ${r.ip}` : ""} (${elapsed}s)`);
}

async function cmdConsole(args: string[]): Promise<void> {
  const name = resolveName(args, await readSplitePin());
  if (!name) bail("usage: splite console [-s name]");
  const record = await findSplite(name);
  if (!record) bail(`splite '${name}' not found in registry`);
  const ip = await readDhcpLease(name);
  if (!ip) bail(`splite '${name}' has no DHCP lease — is it running?`);

  console.error(
    `connecting to ${name} @ ${ip} — escape: Ctrl+\\ then '.' to detach`,
  );
  const proc = spawn(
    [
      "ssh", "-t", "-e", String.fromCharCode(0x1c),
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-i", PATHS.vmSshKey(name),
      `ubuntu@${ip}`,
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  process.exit(await proc.exited);
}

async function cmdExec(args: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseExecArgs(args);
  } catch (e) {
    console.error(`splite exec: ${(e as Error).message}`);
    bail("usage: splite exec [-s name] [--tty] -- <cmd> [args]");
  }
  const name = parsed.splite ?? (await readSplitePin());
  if (!name) bail("splite exec: no splite specified (use -s or `splite use <name>`)");
  const record = await findSplite(name);
  if (!record) bail(`splite '${name}' not found in registry`);
  const ip = await readDhcpLease(name);
  if (!ip) bail(`splite '${name}' has no DHCP lease — is it running?`);

  const sshArgs = [
    "ssh",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-i", PATHS.vmSshKey(name),
    ...(parsed.tty ? ["-t"] : []),
    `ubuntu@${ip}`,
    "--",
    ...parsed.cmd,
  ];

  const proc = spawn(sshArgs, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exit(await proc.exited);
}

async function cmdUse(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) bail("usage: splite use <name>");
  // Ask splited (not the registry directly) so the user gets a meaningful
  // error if the daemon isn't reachable — same failure mode as everything else.
  await call<SpliteResource>("GET", `/v1/splites/${encodeURIComponent(name)}`);
  const path = join(process.cwd(), ".splite");
  await writeFile(path, JSON.stringify({ splite: name }) + "\n");
  console.log(`pinned ${name} → ${path}`);
}

async function cmdApi(args: string[]): Promise<void> {
  // Raw passthrough — keeps its own fetch (returns body verbatim, doesn't
  // assume JSON, prints non-2xx body to stdout before exiting).
  const dIdx = args.findIndex((a) => a === "-d" || a === "--data");
  let bodyArg: string | undefined;
  let positional: string[] = args;
  if (dIdx >= 0) {
    bodyArg = args[dIdx + 1];
    positional = args.slice(0, dIdx).concat(args.slice(dIdx + 2));
  }

  let method = "GET";
  let path: string | undefined;
  if (positional.length === 1) path = positional[0];
  else if (positional.length === 2) { method = positional[0]!.toUpperCase(); path = positional[1]; }
  else bail("usage: splite api [METHOD] <path> [-d <json>|-]");
  if (!path || !path.startsWith("/")) bail("splite api: path must start with '/'");

  const token = process.env.SPLITES_TOKEN ?? (await readToken());
  if (!token) bail("splite api: no token (set SPLITES_TOKEN or run splited once)");
  const baseUrl = process.env.SPLITES_API_URL ?? "http://127.0.0.1:7878";

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
    console.error(`splite api: cannot reach ${baseUrl} — is splited running?`);
    bail(`  ${(e as Error).message}`);
  }
  const text = await r.text();
  if (text.length > 0) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  if (!r.ok) bail(`splite api: ${method} ${path} → ${r.status}`);
}

type Handler = (args: string[]) => void | Promise<void>;

function notImplemented(verb: string, phase: number): Handler {
  return () => {
    console.error(`splite ${verb}: not implemented (lands in phase ${phase})`);
    process.exit(2);
  };
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
  url:        cmdUrl,
  proxy:      notImplemented("proxy", 9),
  api:        cmdApi,
};

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
  console.error(`splite: unknown command '${verb}'. Run 'splite --help' for usage.`);
  process.exit(64);
}

await handler(args.slice(1));
