#!/usr/bin/env bun
// Splite CLI — thin client over splited's REST API. Mirrors sprites verbs.
// Subcommands land phase-by-phase; see docs/MVP-PLAN.md.

import { listSplites } from "../lib/registry.ts";
import { LumeClient, type VMSummary } from "../engine/lume.ts";
import { readDhcpLease } from "../lib/dhcp.ts";

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

type Handler = (args: string[]) => void | Promise<void>;

function notImplemented(verb: string, phase: number): Handler {
  return () => {
    console.error(`splite ${verb}: not implemented (lands in phase ${phase})`);
    process.exit(2);
  };
}

const COMMANDS: Record<string, Handler> = {
  create:     notImplemented("create", 3),
  destroy:    notImplemented("destroy", 7),
  rm:         notImplemented("rm", 7),
  list:       cmdList,
  info:       notImplemented("info", 3),
  use:        notImplemented("use", 3),
  exec:       notImplemented("exec", 4),
  console:    notImplemented("console", 4),
  start:      notImplemented("start", 5),
  stop:       notImplemented("stop", 5),
  checkpoint: notImplemented("checkpoint", 6),
  url:        notImplemented("url", 9),
  proxy:      notImplemented("proxy", 9),
  api:        notImplemented("api", 8),
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
