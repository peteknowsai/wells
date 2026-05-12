#!/usr/bin/env bun
// A.1.3.g — scenario coverage smoke.
//
// Exercises the watchdog signal coverage claims from docs/state-tiers.md
// against a live well. The doc lists 10 scenarios (S1–S10); this smoke
// hits four scenario *families* that map cleanly to the signals we
// actually wired (sig-2/3/4/5 welld-internal + sig-6 host-side ssh
// lsof). The findings doc spells out per-scenario verdicts; this smoke
// proves the wired path behaves as documented.
//
// Cases:
//   - S10 (quiet idle)     — no touches, no probe hits → sleep after threshold.
//   - S2  (ssh held open)  — sig-6 keeps the well alive past threshold.
//   - S5/S8 family (WS)    — welld-internal touch from exec WS keeps alive.
//   - S1  (silent compile) — no external chatter → sleeps (CONFIRMS GAP).
//
// auto_sleep_seconds is set to 30s for the duration of the smoke so wall
// clock stays under 5 minutes. The watchdog ticks every 30s
// (daemon/welld.ts:1949), so the sleep-window the watchdog observes is
// [auto_sleep_seconds, auto_sleep_seconds + 30s].
//
// Usage:
//   bun run scripts/smoke-scenario-coverage.ts [--name=<n>] [--keep]
//                                              [--image=<n>]
//                                              [--report=<path>]
//
// Defaults target dev welld :7879. Stable :7878 is off-limits during
// cells testing (CLAUDE.md hard rule).

import { homedir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";

interface Args {
  name: string;
  image: string;
  keep: boolean;
  report: string;
  baseUrl: string;
  autoSleepSec: number;
}

function parseArgs(argv: string[]): Args {
  const flag = (k: string, def: string): string => {
    const long = argv.find((a) => a.startsWith(`--${k}=`));
    if (long) return long.slice(k.length + 3);
    return def;
  };
  const today = new Date().toISOString().slice(0, 10);
  return {
    name: flag("name", "scenario-cov"),
    image: flag("image", "ubuntu-25.10-base"),
    keep: argv.includes("--keep"),
    report: flag("report", `docs/findings-scenario-coverage-${today}.md`),
    baseUrl: process.env.WELL_BASE_URL ?? "http://127.0.0.1:7879",
    autoSleepSec: Number(flag("auto-sleep", "30")),
  };
}

async function readToken(baseUrl: string): Promise<string> {
  const stateDir = baseUrl.includes(":7879") ? ".wells-dev" : ".wells";
  return (await readFile(join(homedir(), stateDir, "token"), "utf-8")).trim();
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

type WellInfo = { name: string; status: string; ip?: string };

// IMPORTANT: every GET /v1/wells/<name>* call touches the watchdog
// (daemon/welld.ts:469 — touchMatch regex). Polling that path while
// observing for auto-hibernation would reset the activity timer on
// every poll. So state checks during sleep windows read from disk
// directly. `status()` is reserved for moments where touching is fine
// (e.g. one-shot post-wake confirmation).
async function status(
  baseUrl: string,
  token: string,
  name: string,
): Promise<WellInfo> {
  return api<WellInfo>(baseUrl, token, "GET", `/v1/wells/${name}`);
}

function stateDir(baseUrl: string): string {
  return baseUrl.includes(":7879") ? ".wells-dev" : ".wells";
}

// Read the well's runtime.json + registry entry from disk without
// touching the watchdog. Returns "unknown" if either is missing.
async function statusFromDisk(
  baseUrl: string,
  name: string,
): Promise<string> {
  const regPath = join(homedir(), stateDir(baseUrl), "registry.json");
  try {
    const reg = JSON.parse(await readFile(regPath, "utf-8")) as {
      wells?: Array<{ name: string; status?: string }>;
    };
    const entry = reg.wells?.find((w) => w.name === name);
    if (entry?.status) return entry.status;
  } catch {
    // fall through
  }
  // Fallback: runtime.json's state field.
  try {
    const rt = JSON.parse(
      await readFile(
        join(homedir(), stateDir(baseUrl), "vms", name, "runtime.json"),
        "utf-8",
      ),
    ) as { state?: string };
    if (rt.state) return rt.state;
  } catch {
    // fall through
  }
  return "unknown";
}

function keyPath(name: string, baseUrl: string): string {
  const root = baseUrl.includes(":7879") ? ".wells-dev" : ".wells";
  return join(homedir(), root, "vms", name, "ssh_key");
}

async function sshOnce(
  name: string,
  ip: string,
  baseUrl: string,
  cmd: string,
): Promise<boolean> {
  const k = keyPath(name, baseUrl);
  if (!existsSync(k)) return false;
  const proc = spawn(
    [
      "ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=2", "-o", "BatchMode=yes", "-o", "LogLevel=ERROR",
      "-i", k, `well@${ip}`, cmd,
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
  return (await proc.exited) === 0;
}

// Holds an ssh session open for `holdMs`. Used to simulate S2 (interactive
// session) — the connection registers on the host-side `lsof -iTCP@<ip>:22
// -sTCP:ESTABLISHED` probe (sig-6).
function sshHold(
  name: string,
  ip: string,
  baseUrl: string,
  holdMs: number,
): ReturnType<typeof spawn> {
  const k = keyPath(name, baseUrl);
  return spawn(
    [
      "ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", "-o", "LogLevel=ERROR",
      "-o", "ServerAliveInterval=10",
      "-i", k, `well@${ip}`, `sleep ${Math.ceil(holdMs / 1000)}`,
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
}

// Disk-poll variant — for waiting on auto-hibernation. Does NOT touch
// the watchdog (see notes on `status()`).
async function waitForStateDisk(
  baseUrl: string,
  name: string,
  want: string,
  timeoutMs: number,
): Promise<{ matched: boolean; observed: string; ms: number }> {
  const start = Date.now();
  let observed = "unknown";
  while (Date.now() - start < timeoutMs) {
    observed = await statusFromDisk(baseUrl, name);
    if (observed === want) {
      return { matched: true, observed, ms: Date.now() - start };
    }
    await Bun.sleep(2000);
  }
  return { matched: false, observed, ms: Date.now() - start };
}

// API-poll variant — for waking back to "running" where we DO want the
// touch to register (recent activity from the wake itself).
async function waitForStateApi(
  baseUrl: string,
  token: string,
  name: string,
  want: string,
  timeoutMs: number,
): Promise<{ matched: boolean; observed: string; ms: number }> {
  const start = Date.now();
  let observed = "unknown";
  while (Date.now() - start < timeoutMs) {
    try {
      const s = await status(baseUrl, token, name);
      observed = s.status;
      if (s.status === want) {
        return { matched: true, observed, ms: Date.now() - start };
      }
    } catch {
      // 404 between hibernate/wake is briefly possible; treat as miss.
    }
    await Bun.sleep(2000);
  }
  return { matched: false, observed, ms: Date.now() - start };
}

interface Verdict {
  scenario: string;
  family: string;
  signal: string;
  expected: string;
  observed: string;
  pass: boolean;
  durationS: number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`smoke-scenario-coverage: target=${args.baseUrl}, well=${args.name}, auto_sleep=${args.autoSleepSec}s`);

  const token = await readToken(args.baseUrl);
  const verdicts: Verdict[] = [];

  // Provision the well with the tight auto_sleep_seconds for this smoke.
  // (Touching during setup is fine; the sensitive part is the sleep
  // windows below.)
  let ip: string;
  try {
    const existing = await status(args.baseUrl, token, args.name);
    if (existing.status === "hibernating") {
      console.log("  existing well is hibernating; waking…");
      await api(args.baseUrl, token, "POST", `/v1/wells/${args.name}/wake`);
    }
    const fresh = await status(args.baseUrl, token, args.name);
    ip = fresh.ip ?? "";
    console.log(`  reusing ${args.name} at ${ip}`);
  } catch {
    console.log(`  creating ${args.name}…`);
    const created = await api<WellInfo>(
      args.baseUrl,
      token,
      "POST",
      "/v1/wells",
      {
        name: args.name,
        from_image: args.image,
        auto_sleep_seconds: args.autoSleepSec,
      },
    );
    ip = created.ip ?? "";
    console.log(`  created ${args.name} at ${ip}`);
  }

  // Make sure auto_sleep_seconds reflects what we want for this smoke
  // (existing well might have a different value).
  await api(args.baseUrl, token, "PATCH", `/v1/wells/${args.name}`, {
    auto_sleep_seconds: args.autoSleepSec,
  });

  const sleepWindowMs = (args.autoSleepSec + 35) * 1000; // threshold + one tick
  const activeHoldMs = (args.autoSleepSec + 45) * 1000;  // > threshold so a sleep WOULD fire if untouched

  // === S10: quiet idle → expect hibernation ===
  console.log("\n[S10] quiet idle → expect hibernation");
  await sshOnce(args.name, ip, args.baseUrl, "true"); // last touch baseline
  await Bun.sleep(2000);
  // Now sit idle — disk-poll so we don't keep touching.
  const t0 = Date.now();
  const r10 = await waitForStateDisk(args.baseUrl, args.name, "hibernating", sleepWindowMs);
  verdicts.push({
    scenario: "S10",
    family: "quiet idle",
    signal: "none (auto_sleep_seconds elapsed)",
    expected: "hibernating",
    observed: r10.observed,
    pass: r10.matched,
    durationS: Math.round((Date.now() - t0) / 1000),
  });
  console.log(`  observed=${r10.observed} matched=${r10.matched} in ${Math.round(r10.ms / 1000)}s`);

  // Wake before next case.
  console.log("  waking for next case…");
  await api(args.baseUrl, token, "POST", `/v1/wells/${args.name}/wake`);
  const woken = await waitForStateApi(args.baseUrl, token, args.name, "running", 15_000);
  if (!woken.matched) throw new Error(`wake failed: ${woken.observed}`);
  // SSH may take a moment after wake.
  await Bun.sleep(2000);

  // === S2: ssh hold-open → expect well stays alive ===
  console.log("\n[S2] ssh held open → expect well stays alive past threshold (sig-6)");
  const t2 = Date.now();
  const holder = sshHold(args.name, ip, args.baseUrl, activeHoldMs);
  await Bun.sleep(activeHoldMs);
  const s2State = await statusFromDisk(args.baseUrl, args.name);
  holder.kill();
  verdicts.push({
    scenario: "S2",
    family: "ssh ESTABLISHED",
    signal: "sig-6 (host lsof)",
    expected: "running",
    observed: s2State,
    pass: s2State === "running",
    durationS: Math.round((Date.now() - t2) / 1000),
  });
  console.log(`  observed=${s2State} after ${Math.round((Date.now() - t2) / 1000)}s`);

  // After releasing ssh, wait for watchdog to hibernate (proves the override
  // is real — once sig-6 clears, the sleep path returns).
  if (s2State === "running") {
    console.log("  releasing ssh; expecting hibernation now…");
    const r2cool = await waitForStateDisk(args.baseUrl, args.name, "hibernating", sleepWindowMs);
    console.log(`  observed=${r2cool.observed} matched=${r2cool.matched} in ${Math.round(r2cool.ms / 1000)}s`);
    if (r2cool.matched) {
      await api(args.baseUrl, token, "POST", `/v1/wells/${args.name}/wake`);
      await waitForStateApi(args.baseUrl, token, args.name, "running", 15_000);
      await Bun.sleep(2000);
    }
  }

  // === S5/S8: periodic WS exec keeps well alive (welld-internal touch) ===
  console.log("\n[S5/S8] periodic well exec → expect well stays alive (welld touch on every call)");
  const t5 = Date.now();
  const execTicker = (async () => {
    const deadline = Date.now() + activeHoldMs;
    while (Date.now() < deadline) {
      await api(args.baseUrl, token, "POST", `/v1/wells/${args.name}/exec`, {
        command: ["true"],
      }).catch(() => undefined);
      await Bun.sleep(10_000);
    }
  })();
  await execTicker;
  const s5State = await statusFromDisk(args.baseUrl, args.name);
  verdicts.push({
    scenario: "S5/S8",
    family: "WS/HTTP exec pings",
    signal: "welld-internal (touch on /v1/wells/* call)",
    expected: "running",
    observed: s5State,
    pass: s5State === "running",
    durationS: Math.round((Date.now() - t5) / 1000),
  });
  console.log(`  observed=${s5State} after ${Math.round((Date.now() - t5) / 1000)}s`);

  // === S1: silent in-guest work (simulated as long in-guest sleep w/o external traffic) ===
  console.log("\n[S1] silent in-guest sleep (simulates long compile) → expect GAP: well sleeps");
  if (s5State === "hibernating") {
    await api(args.baseUrl, token, "POST", `/v1/wells/${args.name}/wake`);
    await waitForStateApi(args.baseUrl, token, args.name, "running", 15_000);
    await Bun.sleep(2000);
  }
  // Fire-and-forget in-guest "compile" — ssh exits quickly so no sig-6 hold.
  const t1 = Date.now();
  await sshOnce(args.name, ip, args.baseUrl, `nohup sh -c 'sleep ${args.autoSleepSec + 60}' >/dev/null 2>&1 &`);
  // Wait for hibernation — gap means it WILL hibernate even though the
  // guest is "busy" from its perspective. Disk-poll to avoid touching.
  const r1 = await waitForStateDisk(args.baseUrl, args.name, "hibernating", sleepWindowMs);
  verdicts.push({
    scenario: "S1",
    family: "silent in-guest work",
    signal: "NONE WIRED (sig-7/8 deferred)",
    expected: "hibernating (GAP — confirms missing coverage)",
    observed: r1.observed,
    pass: r1.matched, // pass = gap was observed exactly as documented
    durationS: Math.round((Date.now() - t1) / 1000),
  });
  console.log(`  observed=${r1.observed} matched=${r1.matched} in ${Math.round(r1.ms / 1000)}s`);
  console.log(`  (this is a gap, NOT a regression — sig-7/8 were deferred; mitigation: auto_sleep_seconds=null per-well)`);

  // Cleanup
  if (!args.keep) {
    console.log("\n  cleaning up smoke well…");
    try {
      await api(args.baseUrl, token, "DELETE", `/v1/wells/${args.name}`);
    } catch (e) {
      console.log(`  cleanup warning: ${(e as Error).message}`);
    }
  }

  // Report
  const today = new Date().toISOString().slice(0, 10);
  const passCount = verdicts.filter((v) => v.pass).length;
  const lines: string[] = [];
  lines.push(`# findings — scenario coverage smoke (A.1.3.g)\n`);
  lines.push(`Ran \`scripts/smoke-scenario-coverage.ts\` against ${args.baseUrl} on ${today}.`);
  lines.push(`Well: \`${args.name}\` · auto_sleep_seconds=${args.autoSleepSec}s · watchdog tick=30s.\n`);
  lines.push(`## Results\n`);
  lines.push(`| scenario | family | wired signal | expected | observed | pass | wall-clock |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const v of verdicts) {
    lines.push(
      `| ${v.scenario} | ${v.family} | ${v.signal} | ${v.expected} | ${v.observed} | ${v.pass ? "✅" : "❌"} | ${v.durationS}s |`,
    );
  }
  lines.push(``);
  lines.push(`**Summary:** ${passCount}/${verdicts.length} matched expected. `);
  if (passCount === verdicts.length) {
    lines.push(`All wired signal claims hold; documented S1 gap reproduces as designed (mitigated by \`auto_sleep_seconds=null\`).\n`);
  } else {
    lines.push(`Investigate divergences before ticking A.1.3.g.\n`);
  }

  await writeFile(args.report, lines.join("\n"));
  console.log(`\nReport written: ${args.report}`);
  console.log(`Results: ${passCount}/${verdicts.length} matched expected.`);
  if (passCount !== verdicts.length) process.exit(1);
}

main().catch((e) => {
  console.error("smoke failed:", (e as Error).message);
  process.exit(1);
});
