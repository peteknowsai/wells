#!/usr/bin/env bun
// W.13 / B.0.11.d — concurrent-fork crash threshold experiment.
//
// Background: cells team's pool/eggs design (docs/proposals/cells-pool-on-
// wells.md) needs to know how many concurrent `well create --from-image`
// requests welld can handle before lume serve hangs or crashes. Earlier
// reports said three concurrent forks triggered "lume serve unresponsive;
// respawning" + the in-flight forks hung. This experiment finds the
// actual threshold and captures the crash signature.
//
// What it does:
//   For N in --range (default 2,3,4,5,6):
//     - Snapshot lume PID + healthz state before.
//     - Kick off N parallel `well create --from-image` against dev welld.
//     - Watch healthz every 1s during the burst; record any
//       respawns_last_1min increases (i.e., the supervisor SIGKILL'd lume).
//     - After all N complete (success or fail), capture:
//         * fork outcome per VM (success / 4xx / 5xx / timeout)
//         * lume PID after — same as before? if not, lume respawned.
//         * vz_xpc_count — orphan VZ children left behind?
//         * any /tmp/lume-hang-*.txt sample dumps that landed during the
//           experiment window.
//     - Cleanup: destroy successful wells before next N.
//   Write everything to docs/findings-concurrent-fork-crash.md.
//
// Targets dev welld :7879 by default. Live-verify is blocked on W.18 —
// this script ships now so the experiment is ready to run the moment
// dev unblocks. Stable :7878 is OFF-LIMITS for this kind of stress.
//
// Usage:
//   bun run scripts/exp-concurrent-fork.ts [--range=2,3,4,5] [--image=<n>]
//                                           [--prefix=ccfork] [--keep]
//                                           [--report=<path>]

import { homedir } from "node:os";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface Args {
  range: number[];
  image: string;
  prefix: string;
  keep: boolean;
  report: string;
  baseUrl: string;
}

function parseArgs(argv: string[]): Args {
  const flag = (k: string, def: string): string => {
    const m = argv.find((a) => a.startsWith(`--${k}=`));
    return m ? m.slice(k.length + 3) : def;
  };
  const today = new Date().toISOString().slice(0, 10);
  return {
    range: flag("range", "2,3,4,5")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 1),
    image: flag("image", "ubuntu-25.10-base"),
    prefix: flag("prefix", "ccfork"),
    keep: argv.includes("--keep"),
    report: flag("report", `docs/findings-concurrent-fork-crash.md`),
    baseUrl: process.env.WELL_BASE_URL ?? "http://127.0.0.1:7879",
  };
}

async function readToken(baseUrl: string): Promise<string> {
  const stateDir = baseUrl.includes(":7879") ? ".wells-dev" : ".wells";
  return (await readFile(join(homedir(), stateDir, "token"), "utf-8")).trim();
}

interface HealthzPool {
  target_size: number;
  ready_count: number;
  provisioning_count: number;
  warming_count: number;
  adopting_count: number;
}

interface Healthz {
  ok: boolean;
  lume: {
    base_url: string;
    owned: boolean;
    respawns_last_hour: number;
    respawns_last_5min: number;
    respawns_last_1min: number;
  };
  vz_xpc_count: number;
  degraded: boolean;
  pool: HealthzPool;
}

async function api<T = unknown>(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
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

async function getHealthz(baseUrl: string): Promise<Healthz> {
  const r = await fetch(`${baseUrl}/healthz`);
  if (!r.ok) throw new Error(`healthz → ${r.status}`);
  return (await r.json()) as Healthz;
}

async function lumePidViaLsof(): Promise<number | null> {
  const port = process.env.WELL_LUME_PORT ?? "7780";
  const proc = Bun.spawn(["lsof", "-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-t"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim().split(/\s+/)[0];
  await proc.exited;
  const n = Number(out);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function captureSample(pid: number, label: string): Promise<string> {
  const path = `/tmp/exp-ccfork-${label}-${pid}.txt`;
  const proc = Bun.spawn(["sample", String(pid), "1", "-file", path], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
  return path;
}

async function listLumeHangFiles(sinceMs: number): Promise<string[]> {
  try {
    const dir = "/tmp";
    const entries = await readdir(dir);
    const matches: string[] = [];
    for (const e of entries) {
      if (!e.startsWith("lume-hang-")) continue;
      const full = join(dir, e);
      const s = await stat(full);
      if (s.mtimeMs >= sinceMs) matches.push(full);
    }
    return matches;
  } catch {
    return [];
  }
}

interface ForkOutcome {
  name: string;
  status: "success" | "client_error" | "server_error" | "timeout";
  durationMs: number;
  errorBody?: string;
  ip?: string;
}

async function runForks(
  baseUrl: string,
  token: string,
  count: number,
  prefix: string,
  image: string,
): Promise<ForkOutcome[]> {
  const stamp = Date.now().toString(36).slice(-4);
  const names = Array.from({ length: count }, (_, i) => `${prefix}-${stamp}-${count}-${i + 1}`);
  const tasks = names.map(async (name): Promise<ForkOutcome> => {
    const t0 = Date.now();
    try {
      const r = await api<{ name: string; ip: string }>(
        baseUrl,
        token,
        "POST",
        "/v1/wells",
        { name, from_image: image },
      );
      return {
        name,
        status: "success",
        durationMs: Date.now() - t0,
        ip: r.ip,
      };
    } catch (e) {
      const msg = (e as Error).message;
      const status: ForkOutcome["status"] = /→ 5\d\d/.test(msg)
        ? "server_error"
        : /→ 4\d\d/.test(msg)
          ? "client_error"
          : "timeout";
      return { name, status, durationMs: Date.now() - t0, errorBody: msg };
    }
  });
  return Promise.all(tasks);
}

async function destroyAll(
  baseUrl: string,
  token: string,
  outcomes: ForkOutcome[],
): Promise<void> {
  for (const o of outcomes) {
    try {
      await api(baseUrl, token, "DELETE", `/v1/wells/${o.name}`);
    } catch {
      /* best-effort */
    }
  }
}

interface RoundResult {
  n: number;
  startedAt: string;
  endedAt: string;
  outcomes: ForkOutcome[];
  lumePidBefore: number | null;
  lumePidAfter: number | null;
  lumeRespawned: boolean;
  respawnsBefore: number;
  respawnsAfter: number;
  vzXpcBefore: number;
  vzXpcAfter: number;
  hangFiles: string[];
  preSamplePath: string | null;
}

async function runRound(args: Args, token: string, n: number): Promise<RoundResult> {
  console.log(`\n=== N=${n} ===`);
  const startedAt = new Date().toISOString();
  const sinceMs = Date.now();

  const healthBefore = await getHealthz(args.baseUrl);
  const lumePidBefore = await lumePidViaLsof();
  console.log(
    `  before: lume_pid=${lumePidBefore ?? "?"} respawns_1m=${healthBefore.lume.respawns_last_1min} vz_xpc=${healthBefore.vz_xpc_count}`,
  );

  // Capture a baseline `sample` of lume — useful diff target if it
  // hangs after the burst.
  let preSamplePath: string | null = null;
  if (lumePidBefore) {
    preSamplePath = await captureSample(lumePidBefore, `pre-N${n}`);
  }

  console.log(`  launching ${n} concurrent creates…`);
  const outcomes = await runForks(args.baseUrl, token, n, args.prefix, args.image);
  for (const o of outcomes) {
    console.log(
      `    ${o.status === "success" ? "✓" : "✗"} ${o.name} ${o.status} ${o.durationMs}ms${o.errorBody ? ` — ${o.errorBody.slice(0, 80)}` : ""}`,
    );
  }

  const healthAfter = await getHealthz(args.baseUrl);
  const lumePidAfter = await lumePidViaLsof();
  const lumeRespawned =
    (lumePidAfter !== lumePidBefore && lumePidBefore !== null) ||
    healthAfter.lume.respawns_last_1min > healthBefore.lume.respawns_last_1min;
  console.log(
    `  after: lume_pid=${lumePidAfter ?? "?"} respawns_1m=${healthAfter.lume.respawns_last_1min} vz_xpc=${healthAfter.vz_xpc_count} respawned=${lumeRespawned}`,
  );

  const hangFiles = await listLumeHangFiles(sinceMs);
  if (hangFiles.length > 0) {
    console.log(`  ⚠ ${hangFiles.length} lume-hang sample dump(s) landed during this round:`);
    for (const f of hangFiles) console.log(`    ${f}`);
  }

  // Cleanup successes before next round so each N starts on the same
  // lume free-resource baseline.
  if (!args.keep) {
    console.log(`  cleanup…`);
    await destroyAll(args.baseUrl, token, outcomes.filter((o) => o.status === "success"));
  }

  return {
    n,
    startedAt,
    endedAt: new Date().toISOString(),
    outcomes,
    lumePidBefore,
    lumePidAfter,
    lumeRespawned,
    respawnsBefore: healthBefore.lume.respawns_last_1min,
    respawnsAfter: healthAfter.lume.respawns_last_1min,
    vzXpcBefore: healthBefore.vz_xpc_count,
    vzXpcAfter: healthAfter.vz_xpc_count,
    hangFiles,
    preSamplePath,
  };
}

function renderReport(args: Args, results: RoundResult[]): string {
  const ts = new Date().toISOString();
  const threshold = results.find((r) => r.lumeRespawned || r.outcomes.some((o) => o.status !== "success"));

  return `# findings — concurrent fork crash threshold (W.13 / B.0.11.d)

**Run:** ${ts}
**Target:** ${args.baseUrl}
**Image:** ${args.image}
**Range:** ${args.range.join(", ")}
${threshold ? `**Crash threshold:** N=${threshold.n} (lume_respawned=${threshold.lumeRespawned}, ${threshold.outcomes.filter((o) => o.status !== "success").length}/${threshold.n} forks failed)` : "**Crash threshold:** not reached in tested range — try wider"}

## Summary

| N | success | client_err | server_err | timeout | lume_respawned | vz_xpc Δ | hang files |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
${results
  .map((r) => {
    const ok = r.outcomes.filter((o) => o.status === "success").length;
    const ce = r.outcomes.filter((o) => o.status === "client_error").length;
    const se = r.outcomes.filter((o) => o.status === "server_error").length;
    const to = r.outcomes.filter((o) => o.status === "timeout").length;
    const dxpc = r.vzXpcAfter - r.vzXpcBefore;
    return `| ${r.n} | ${ok} | ${ce} | ${se} | ${to} | ${r.lumeRespawned ? "✓" : "—"} | ${dxpc >= 0 ? "+" : ""}${dxpc} | ${r.hangFiles.length} |`;
  })
  .join("\n")}

## Per-round detail

${results
  .map(
    (r) => `### N=${r.n} (${r.startedAt} → ${r.endedAt})

- lume PID: ${r.lumePidBefore ?? "?"} → ${r.lumePidAfter ?? "?"}${r.lumeRespawned ? "  **(respawned)**" : ""}
- respawns_last_1min: ${r.respawnsBefore} → ${r.respawnsAfter}
- vz_xpc_count: ${r.vzXpcBefore} → ${r.vzXpcAfter}
- pre-burst sample: ${r.preSamplePath ?? "_(no pid)_"}
${r.hangFiles.length > 0 ? `- lume-hang dumps during round:\n${r.hangFiles.map((f) => `    - ${f}`).join("\n")}` : "- no lume-hang dumps during round"}

| name | status | duration | ip / error |
| --- | --- | ---: | --- |
${r.outcomes.map((o) => `| ${o.name} | ${o.status} | ${o.durationMs}ms | ${o.status === "success" ? (o.ip ?? "") : (o.errorBody?.slice(0, 100) ?? "")} |`).join("\n")}
`,
  )
  .join("\n")}

## How to read this

- **Crash threshold** is the smallest N where either (a) lume serve respawned during the round (supervisor SIGKILL'd it), or (b) at least one fork failed with a 5xx / timeout. Below the threshold the path is solid; at and above, pool fan-out + cells team scale-out can hit it.
- **vz_xpc Δ** > 0 after a round suggests orphan VZ children — VMs that lume didn't reap. Should be 0 on a clean round (every well destroyed before the next round).
- **hang files** are /tmp/lume-hang-\*.txt stack samples the supervisor captured pre-respawn (B.0.11.h). When present, read them alongside the pre-burst sample to see what changed in the call stack.
- **server_error** typically maps to "lume returned 500 / 4xx" — bundle creation race or VZ.framework constraint. **timeout** maps to "welld saw the request stall past its inner deadlines" — usually the @MainActor block.

## Reproducing

\`\`\`
bun run scripts/exp-concurrent-fork.ts --range=2,3,4,5,6 --keep
\`\`\`

\`--keep\` leaves wells in place between rounds so you can SSH in and inspect; default behavior cleans up so each N starts on the same baseline. Stable :7878 is off-limits — only run against dev :7879.
`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `exp-concurrent-fork — base=${args.baseUrl} range=${args.range.join(",")} image=${args.image}`,
  );
  const token = await readToken(args.baseUrl);

  const results: RoundResult[] = [];
  for (const n of args.range) {
    results.push(await runRound(args, token, n));
    // Small breathing room between rounds — let the supervisor
    // settle if it's mid-respawn so the next round's "before" snapshot
    // isn't measuring an in-flight transition.
    await Bun.sleep(2_000);
  }

  const reportPath = join(process.cwd(), args.report);
  await writeFile(reportPath, renderReport(args, results));
  console.log(`\nwrote ${args.report}`);

  const anyCrash = results.some((r) => r.lumeRespawned || r.outcomes.some((o) => o.status !== "success"));
  if (anyCrash) {
    const first = results.find((r) => r.lumeRespawned || r.outcomes.some((o) => o.status !== "success"));
    console.log(`\nFINDING: crash threshold reached at N=${first?.n ?? "?"} — see report for stack samples`);
  } else {
    console.log(`\nFINDING: no crash in tested range. Re-run with wider --range to find the ceiling.`);
  }
}

main().catch((e) => {
  console.error(`exp-concurrent-fork failed: ${(e as Error).message}`);
  process.exit(1);
});
