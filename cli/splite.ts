#!/usr/bin/env bun
// Splite CLI — thin client over splited's REST API. Mirrors sprites verbs.
// Subcommands land phase-by-phase; see docs/MVP-PLAN.md.

import { writeFile } from "node:fs/promises";
import { openSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { findSplite, listSplites } from "../lib/registry.ts";
import { LumeClient, type VMSummary } from "../engine/lume.ts";
import { readDhcpLease } from "../lib/dhcp.ts";
import { createSplite, diskUsageBytes } from "../lib/createSplite.ts";
import { parseExecArgs } from "../lib/parseExecArgs.ts";
import { readSplitePin } from "../lib/resolve.ts";
import { PATHS } from "../lib/state.ts";
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "../lib/checkpoints.ts";
import { stopSplite, startSplite } from "../lib/lifecycle.ts";
import { destroySplite } from "../lib/destroy.ts";
import { readToken } from "../lib/token.ts";

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
  api [-s name] <path>     Raw REST passthrough to splited

Global flags:
  -s, --splite <name>      Target splite (overrides .splite in cwd)
  -v, --version            Print version
  -h, --help               Print this help
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

async function cmdList(): Promise<void> {
  const splites = await listSplites();
  if (splites.length === 0) {
    console.log("no splites");
    return;
  }
  const lume = new LumeClient();
  const lumeList = await lume.list().catch(() => [] as VMSummary[]);
  const lumeByName = new Map(lumeList.map((v) => [v.name, v]));

  const rows = await Promise.all(
    splites.map(async (s) => {
      const lv = lumeByName.get(s.name);
      const status =
        (typeof lv?.status === "string" ? lv.status : null) ?? "missing";
      const ip = (await readDhcpLease(s.name)) ?? "—";
      return { name: s.name, status, ip, age: humanAge(s.created_at) };
    }),
  );

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

function parseFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const a = args.find((x) => x.startsWith(prefix));
  return a?.slice(prefix.length);
}

async function cmdCreate(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  if (!name) {
    console.error("usage: splite create <name> [--cpu=N] [--memory=NGB] [--disk=NGB]");
    process.exit(1);
  }
  const cpuRaw = parseFlag(args, "cpu");
  const memory = parseFlag(args, "memory");
  const disk = parseFlag(args, "disk");
  const cpu = cpuRaw ? parseInt(cpuRaw, 10) : undefined;
  if (cpuRaw && (!Number.isFinite(cpu) || cpu! <= 0)) {
    console.error(`invalid --cpu='${cpuRaw}'`);
    process.exit(1);
  }

  console.log(`creating splite '${name}'…`);
  try {
    const { record, ip } = await createSplite({ name, cpu, memory, disk });
    console.log(
      `splite '${record.name}' created — ${ip} (${record.cpu} vCPU / ${record.memory} / ${record.disk_size})`,
    );
  } catch (e) {
    console.error(`splite create failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)}${units[i]}`;
}

async function cmdInfo(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const json = args.includes("--json");
  const name = positional[0] ?? (await readSplitePin());
  if (!name) {
    console.error("usage: splite info <name>  (or `splite use <name>` to pin)");
    process.exit(1);
  }

  const record = await findSplite(name);
  if (!record) {
    console.error(`splite '${name}' not found in registry`);
    process.exit(1);
  }

  const lume = new LumeClient();
  const lumeInfo = await lume.info(name).catch(() => null);
  const status = (typeof lumeInfo?.status === "string" ? lumeInfo.status : null) ?? "missing";
  const ip = await readDhcpLease(name);
  const diskUsed = await diskUsageBytes(name);

  if (json) {
    console.log(JSON.stringify({
      ...record,
      status,
      ip,
      disk_used_bytes: diskUsed,
    }, null, 2));
    return;
  }

  console.log(`name:     ${record.name}`);
  console.log(`status:   ${status}`);
  console.log(`ip:       ${ip ?? "—"}`);
  console.log(`cpu:      ${record.cpu} vCPU`);
  console.log(`memory:   ${record.memory}`);
  console.log(`disk:     ${record.disk_size} (used: ${diskUsed != null ? fmtBytes(diskUsed) : "—"})`);
  console.log(`created:  ${record.created_at} (${humanAge(record.created_at)} ago)`);
  console.log(`uuid:     ${record.uuid}`);
}

async function cmdApi(args: string[]): Promise<void> {
  // Shape: splite api <path>                     → GET <path>
  //        splite api <METHOD> <path>            → arbitrary method
  //        splite api <METHOD> <path> -d <body>  → with body (literal, or '-' for stdin)
  // Bearer token + URL come from ~/.splites/token + SPLITES_API_URL.

  const dIdx = args.findIndex((a) => a === "-d" || a === "--data");
  let bodyArg: string | undefined;
  let positional: string[] = args;
  if (dIdx >= 0) {
    bodyArg = args[dIdx + 1];
    positional = args.slice(0, dIdx).concat(args.slice(dIdx + 2));
  }

  let method = "GET";
  let path: string | undefined;
  if (positional.length === 1) {
    path = positional[0];
  } else if (positional.length === 2) {
    method = positional[0]!.toUpperCase();
    path = positional[1];
  } else {
    console.error("usage: splite api [METHOD] <path> [-d <json>|-]");
    process.exit(1);
  }
  if (!path || !path.startsWith("/")) {
    console.error("splite api: path must start with '/'");
    process.exit(1);
  }

  const token = process.env.SPLITES_TOKEN ?? (await readToken());
  if (!token) {
    console.error(
      "splite api: no token (set SPLITES_TOKEN or run splited once to auto-generate ~/.splites/token)",
    );
    process.exit(1);
  }
  const baseUrl = process.env.SPLITES_API_URL ?? "http://127.0.0.1:7878";

  let body: string | undefined;
  if (bodyArg === "-") {
    body = await Bun.stdin.text();
  } else if (bodyArg !== undefined) {
    body = bodyArg;
  }

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
    console.error(`  ${(e as Error).message}`);
    process.exit(1);
  }
  const text = await r.text();
  if (text.length > 0) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  if (!r.ok) {
    console.error(`splite api: ${method} ${path} → ${r.status}`);
    process.exit(1);
  }
}

async function cmdDestroy(args: string[]): Promise<void> {
  if (!args.includes("--yes")) {
    console.error("splite destroy: refusing without --yes (this is irreversible)");
    process.exit(1);
  }
  const sIdx = args.findIndex((a) => a === "-s" || a === "--splite");
  let name = sIdx >= 0 ? args[sIdx + 1] : undefined;
  if (!name) {
    name = args.find((a) => !a.startsWith("-") && a !== "yes");
  }
  if (!name) name = await readSplitePin();
  if (!name) {
    console.error("usage: splite destroy <name> --yes  |  splite destroy -s <name> --yes");
    process.exit(1);
  }

  console.log(`destroying ${name}…`);
  const r = await destroySplite(name);
  if (!r.found) {
    console.log(`splite '${name}' not found — nothing to do`);
    return;
  }
  console.log(`splite '${name}' destroyed`);
}

async function cmdCheckpoint(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "create":
      return cmdCheckpointCreate(rest);
    case "list":
      return cmdCheckpointList(rest);
    case "restore":
      return cmdCheckpointRestore(rest);
    default:
      console.error("usage: splite checkpoint <create|list|restore> [args]");
      process.exit(1);
  }
}

async function cmdCheckpointCreate(args: string[]): Promise<void> {
  const sIdx = args.findIndex((a) => a === "-s" || a === "--splite");
  let name = sIdx >= 0 ? args[sIdx + 1] : undefined;
  if (!name) name = await readSplitePin();
  if (!name) {
    console.error("usage: splite checkpoint create [-s name]");
    process.exit(1);
  }
  const t0 = Date.now();
  try {
    const cp = await createCheckpoint(name);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(
      `checkpoint '${cp.id}' created (${elapsed}s, ${fmtBytes(cp.size_bytes)})`,
    );
  } catch (e) {
    console.error(`checkpoint create failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function cmdCheckpointList(args: string[]): Promise<void> {
  const sIdx = args.findIndex((a) => a === "-s" || a === "--splite");
  let name = sIdx >= 0 ? args[sIdx + 1] : undefined;
  if (!name) name = await readSplitePin();
  if (!name) {
    console.error("usage: splite checkpoint list [-s name]");
    process.exit(1);
  }
  const checkpoints = await listCheckpoints(name);
  if (checkpoints.length === 0) {
    console.log(`no checkpoints for ${name}`);
    return;
  }

  const idW = Math.max(2, ...checkpoints.map((c) => c.id.length));
  const ageW = 6;
  console.log(
    `${"ID".padEnd(idW)}  ${"AGE".padEnd(ageW)}  CREATED                    SIZE      DELTA`,
  );
  for (const c of checkpoints) {
    console.log(
      `${c.id.padEnd(idW)}  ${humanAge(c.created_at).padEnd(ageW)}  ${c.created_at}  ${fmtBytes(c.size_bytes).padEnd(8)}  ${fmtBytes(c.physical_bytes)}`,
    );
  }
}

async function cmdCheckpointRestore(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("-"));
  const id = positional[0];
  if (!id) {
    console.error("usage: splite checkpoint restore <id> [-s name]");
    process.exit(1);
  }
  const sIdx = args.findIndex((a) => a === "-s" || a === "--splite");
  let name = sIdx >= 0 ? args[sIdx + 1] : undefined;
  if (!name) name = await readSplitePin();
  if (!name) {
    console.error("splite checkpoint restore: no splite specified");
    process.exit(1);
  }
  console.log(`restoring '${name}' to checkpoint '${id}'…`);
  try {
    const r = await restoreCheckpoint(name, id);
    console.log(`restored — running @ ${r.ip} (boot ${(r.bootMs / 1000).toFixed(1)}s)`);
  } catch (e) {
    console.error(`restore failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function cmdStart(args: string[]): Promise<void> {
  const sIdx = args.findIndex((a) => a === "-s" || a === "--splite");
  let name = sIdx >= 0 ? args[sIdx + 1] : undefined;
  if (!name) name = await readSplitePin();
  if (!name) {
    console.error("usage: splite start [-s name]");
    process.exit(1);
  }
  const record = await findSplite(name);
  if (!record) {
    console.error(`splite '${name}' not found in registry`);
    process.exit(1);
  }
  console.log(`starting ${name}…`);
  const r = await startSplite(name);
  if (r.alreadyRunning) {
    console.log(`splite '${name}' already running${r.ip ? ` @ ${r.ip}` : ""}`);
  } else {
    console.log(`splite '${name}' running @ ${r.ip} (boot ${(r.bootMs / 1000).toFixed(1)}s)`);
  }
}

async function cmdStop(args: string[]): Promise<void> {
  const sIdx = args.findIndex((a) => a === "-s" || a === "--splite");
  let name = sIdx >= 0 ? args[sIdx + 1] : undefined;
  if (!name) name = await readSplitePin();
  if (!name) {
    console.error("usage: splite stop [-s name]");
    process.exit(1);
  }
  const record = await findSplite(name);
  if (!record) {
    console.error(`splite '${name}' not found in registry`);
    process.exit(1);
  }
  const r = await stopSplite(name);
  if (!r.wasRunning) {
    console.log(`splite '${name}' already stopped`);
  } else {
    console.log(`splite '${name}' stopped${r.graceful ? "" : " (forced — guest unreachable)"}`);
  }
}

async function cmdConsole(args: string[]): Promise<void> {
  const sIdx = args.findIndex((a) => a === "-s" || a === "--splite");
  let name = sIdx >= 0 ? args[sIdx + 1] : undefined;
  if (!name) name = await readSplitePin();
  if (!name) {
    console.error("usage: splite console [-s name]");
    process.exit(1);
  }
  const record = await findSplite(name);
  if (!record) {
    console.error(`splite '${name}' not found in registry`);
    process.exit(1);
  }
  const ip = await readDhcpLease(name);
  if (!ip) {
    console.error(`splite '${name}' has no DHCP lease — is it running?`);
    process.exit(1);
  }

  // Set ssh's escape char to Ctrl+\ (byte 0x1c) for sprites parity.
  // Detach: Ctrl+\ then '.' at the start of a line. (ssh's escape char only
  // triggers at line start — that's a libssh-level constraint we accept.)
  console.error(
    `connecting to ${name} @ ${ip} — escape: Ctrl+\\ then '.' to detach`,
  );
  const proc = spawn(
    [
      "ssh",
      "-t",
      "-e", String.fromCharCode(0x1c),
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
    console.error("usage: splite exec [-s name] [--tty] -- <cmd> [args]");
    process.exit(1);
  }
  const name = parsed.splite ?? (await readSplitePin());
  if (!name) {
    console.error("splite exec: no splite specified (use -s or `splite use <name>`)");
    process.exit(1);
  }
  const record = await findSplite(name);
  if (!record) {
    console.error(`splite '${name}' not found in registry`);
    process.exit(1);
  }
  const ip = await readDhcpLease(name);
  if (!ip) {
    console.error(`splite '${name}' has no DHCP lease — is it running?`);
    process.exit(1);
  }

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

  const proc = spawn(sshArgs, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
}

async function cmdUse(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error("usage: splite use <name>");
    process.exit(1);
  }
  const splite = await findSplite(name);
  if (!splite) {
    console.error(`splite '${name}' not found in registry`);
    process.exit(1);
  }
  const path = join(process.cwd(), ".splite");
  await writeFile(path, JSON.stringify({ splite: name }) + "\n");
  console.log(`pinned ${name} → ${path}`);
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
  url:        notImplemented("url", 9),
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
