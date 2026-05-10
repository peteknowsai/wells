#!/usr/bin/env bun
// W.6 — analyze historical `create: profile` entries from welld logs.
//
// Each well-create logs a profile entry like:
//   {"msg":"create: profile","totalMs":14268,"phase":{"vmDir":0,"seed":27,
//    "lumeCreate":30,"waitStopped":41,"clonefile":43,"truncate":45,
//    "lumeStart1":47,"waitRunning1":61,"dhcp1":4063,"ssh1":5240,
//    "shutdownSent":5367,"diskReleased":9226,"lumeStart2":9228,
//    "waitRunning2":9236,"dhcp2":13239,"ssh2":14268}}
//
// Phase values are cumulative (ms since create start). Adjacent
// differences = per-phase cost. This script reads stable + dev welld
// logs, computes per-phase distributions, and writes a findings doc
// pinpointing which phase carries the long tail.
//
// Why historical not live: a fresh 50-cycle stress against dev welld
// is blocked on W.18 (DHCP timeout). This script gets us 80% of the
// answer using profile entries already on disk — 90 historical creates
// is plenty for p50 / p95 / p99 distribution.
//
// Usage:
//   bun run scripts/analyze-create-profile.ts [--logs=path1,path2]
//                                              [--report=path]
//                                              [--since=ISO]

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface Args {
  logs: string[];
  report: string;
  since: number; // ms epoch; 0 = no filter
}

function parseArgs(argv: string[]): Args {
  const flag = (k: string, def: string): string => {
    const m = argv.find((a) => a.startsWith(`--${k}=`));
    return m ? m.slice(k.length + 3) : def;
  };
  const today = new Date().toISOString().slice(0, 10);
  const sinceStr = flag("since", "");
  return {
    logs: flag(
      "logs",
      `${join(homedir(), ".wells/welld.log")},${join(homedir(), ".wells-dev/welld.log")}`,
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    report: flag("report", `docs/findings-create-warm-distribution-${today}.md`),
    since: sinceStr ? Date.parse(sinceStr) : 0,
  };
}

interface ProfileEntry {
  ts: number;
  source: string;
  totalMs: number;
  phase: Record<string, number>;
}

async function loadProfiles(paths: string[], since: number): Promise<ProfileEntry[]> {
  const out: ProfileEntry[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, "utf-8");
    } catch {
      console.warn(`  skip ${path} (unreadable)`);
      continue;
    }
    const source = path.includes(".wells-dev") ? "dev" : "stable";
    let count = 0;
    for (const line of text.split("\n")) {
      if (!line || !line.includes('"create: profile"')) continue;
      try {
        const e = JSON.parse(line) as {
          ts?: string;
          totalMs?: number;
          phase?: Record<string, number>;
        };
        const ts = e.ts ? Date.parse(e.ts) : 0;
        if (since && ts < since) continue;
        if (typeof e.totalMs !== "number" || !e.phase) continue;
        out.push({ ts, source, totalMs: e.totalMs, phase: e.phase });
        count++;
      } catch {
        /* skip malformed line */
      }
    }
    console.log(`  ${source}: ${count} profile entries from ${path}`);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// Phase boundaries in createWell.ts (in mark() call order). Each entry
// is the cumulative ms since create start. Per-phase cost is the diff
// between consecutive entries.
const PHASE_ORDER = [
  "vmDir",
  "seed",
  "lumeCreate",
  "waitStopped",
  "clonefile",
  "truncate",
  "lumeStart1",
  "waitRunning1",
  "dhcp1",
  "ssh1",
  "shutdownSent",
  "diskReleased",
  "lumeStart2",
  "waitRunning2",
  "dhcp2",
  "ssh2",
];

function perPhaseDeltas(p: Record<string, number>): Record<string, number> {
  const deltas: Record<string, number> = {};
  let prev = 0;
  for (const name of PHASE_ORDER) {
    const v = p[name];
    if (typeof v !== "number") continue;
    deltas[name] = v - prev;
    prev = v;
  }
  return deltas;
}

interface Distribution {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

function dist(values: number[]): Distribution {
  if (values.length === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const s = [...values].sort((a, b) => a - b);
  const pct = (p: number) =>
    s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    count: s.length,
    min: s[0]!,
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    max: s.at(-1)!,
    mean: Math.round(sum / s.length),
  };
}

function fmtRow(label: string, d: Distribution): string {
  if (d.count === 0) return `| ${label.padEnd(16)} | (no data) |`;
  return `| ${label.padEnd(16)} | ${String(d.count).padStart(5)} | ${String(d.min).padStart(7)}ms | ${String(d.mean).padStart(7)}ms | ${String(d.p50).padStart(7)}ms | ${String(d.p95).padStart(7)}ms | ${String(d.p99).padStart(7)}ms | ${String(d.max).padStart(7)}ms |`;
}

interface Analysis {
  total: Distribution;
  perPhase: Record<string, Distribution>;
  longTailPhase: string;
  longTailContribution: number; // p95 of that phase, ms
}

function analyze(profiles: ProfileEntry[]): Analysis {
  const totals = profiles.map((p) => p.totalMs);
  const perPhaseValues: Record<string, number[]> = {};
  for (const name of PHASE_ORDER) perPhaseValues[name] = [];
  for (const p of profiles) {
    const deltas = perPhaseDeltas(p.phase);
    for (const [k, v] of Object.entries(deltas)) {
      perPhaseValues[k]?.push(v);
    }
  }
  const perPhase: Record<string, Distribution> = {};
  for (const [k, vs] of Object.entries(perPhaseValues)) {
    perPhase[k] = dist(vs);
  }
  // The "long tail phase" is the phase whose p95 is the largest single
  // contributor to the create's overall p95 — the phase that, if we
  // could halve its p95, would shave the most off the total p95.
  let longTailPhase = "";
  let longTail = 0;
  for (const [name, d] of Object.entries(perPhase)) {
    if (d.p95 > longTail) {
      longTail = d.p95;
      longTailPhase = name;
    }
  }
  return {
    total: dist(totals),
    perPhase,
    longTailPhase,
    longTailContribution: longTail,
  };
}

function renderReport(args: Args, profiles: ProfileEntry[], a: Analysis): string {
  const ts = new Date().toISOString();
  const earliest = profiles[0] ? new Date(profiles[0].ts).toISOString() : "n/a";
  const latest = profiles.at(-1) ? new Date(profiles.at(-1)!.ts).toISOString() : "n/a";
  const stableCount = profiles.filter((p) => p.source === "stable").length;
  const devCount = profiles.filter((p) => p.source === "dev").length;

  const phaseRows = PHASE_ORDER.map((name) => fmtRow(name, a.perPhase[name]!)).join("\n");

  return `# findings — create+warm distribution (W.6 / B.0.9.d.5.b)

**Run:** ${ts}
**Inputs:** ${args.logs.join(", ")}
**Period:** ${earliest} → ${latest}
**Sample size:** ${profiles.length} profiles (${stableCount} stable, ${devCount} dev)

## Total create time

| metric           | count |     min |    mean |     p50 |     p95 |     p99 |     max |
| ---------------- | ----: | ------: | ------: | ------: | ------: | ------: | ------: |
${fmtRow("total", a.total)}

## Per-phase delta (ms each phase took)

| phase            | count |     min |    mean |     p50 |     p95 |     p99 |     max |
| ---------------- | ----: | ------: | ------: | ------: | ------: | ------: | ------: |
${phaseRows}

## Long tail finding

The phase carrying the largest p95 contribution is **\`${a.longTailPhase}\`** at ${a.longTailContribution}ms p95.

Knowing the createWell.ts mark() sequence, this maps to:
${longTailExplanation(a.longTailPhase)}

## Reading the columns

- \`vmDir\`, \`seed\`, \`lumeCreate\`, \`waitStopped\`, \`clonefile\`, \`truncate\` — host-side setup. Tens of ms typical, no VM running yet.
- \`lumeStart1\`, \`waitRunning1\` — first lume.start (with cidata mount). lume HTTP roundtrip; ~50–100ms.
- \`dhcp1\` — first-boot DHCP wait. Should be 4–6s on a clean substrate; >10s suggests vmnet pressure or the DHCP-DUID-collision pattern.
- \`ssh1\` — first SSH-ready wait after first boot. ~1s typical.
- \`shutdownSent\` — sysrq fast-halt SSH. ~100ms.
- \`diskReleased\` — wait for VZ to fully release the bundle disk after halt. 1–4s typical.
- \`lumeStart2\`, \`waitRunning2\` — second lume.start (without cidata, "warming-restart"). ~50ms.
- \`dhcp2\` — second-boot DHCP wait. **Headline regression detector**: should be near-zero with dhcp-identifier:mac in the base image, but if cloud-init isn't disabled this stretches into multi-second territory.
- \`ssh2\` — second SSH-ready wait. ~1s typical.

## Where the next round of optimization work should go

(a) If the long-tail phase is **\`dhcp1\`** or **\`dhcp2\`**, the next move is finishing the cidata-seal / cloud-init-disable plan (B.0.9.d.2 in MVP-PLAN). Detached.

(b) If it's **\`waitRunning1\`** or **\`waitRunning2\`**, that's lume.info() polling — points at lume @MainActor variance. Cross-reference \`/tmp/lume-hang-*\` samples to nail the call site. Aligns with W.7 (lume @MainActor fix).

(c) If it's **\`diskReleased\`**, we're spending budget watching VZ flush the disk. Already optimized to sysrq+poweroff, so further wins probably require a lume-side change (e.g., expose bundle.lock state).

(d) If it's **\`clonefile\`**, the base image is too big or APFS clonefile isn't actually being used — investigate.

## How to interpret outliers

p99 / max values that diverge sharply from p95 mean a small number of forks took dramatically longer. That's exactly the W.6 long-tail variance pattern. To find which fires hit the tail:

\`\`\`
grep "create: profile" ~/.wells/welld.log ~/.wells-dev/welld.log \\
  | jq -r 'select(.totalMs > NNNN) | .ts + " " + (.totalMs | tostring) + "ms"' | sort
\`\`\`

(replace NNNN with whatever threshold you care about; e.g., > p95).

## What this analysis can't tell us

- **First-create-on-fresh-host cost** — most profiles are warm-start, after lume + base image are cached. The first cold create on a freshly-restarted Mac may have different timing.
- **Concurrent-fork variance** (W.13) — profiles are per-fork totals; concurrent fan-out adds contention not captured here.
- **Pool-adopt path latency** — adoption is a different code path (~2-3s end-to-end) that doesn't emit \`create: profile\`. The pool smoke (smoke-warm-pool, smoke-pool-churn) covers that.

## Reproducing

\`\`\`
bun run scripts/analyze-create-profile.ts \\
  [--logs=PATH1,PATH2] [--since=2026-05-09] \\
  [--report=docs/findings-create-warm-distribution.md]
\`\`\`
`;
}

function longTailExplanation(phase: string): string {
  switch (phase) {
    case "dhcp1":
      return "**First-boot DHCP wait** (\`waitForDhcpLease\`, 90s timeout, lib/createWell.ts:472). Long-tail typically means vmnet pressure (lots of stale leases) or the cidata seed didn't deliver a clean hostname for matching.";
    case "dhcp2":
      return "**Warming-restart DHCP wait** (\`waitForDhcpLease\`, lib/createWell.ts:540). Long-tail here historically meant cloud-init firing on second boot (B.0.9.d.2 plan); after the dhcp-identifier:mac netplan + swap-pre-allocation in the base image (2026-05-09 18:27 PT), this should be near-zero.";
    case "ssh1":
    case "ssh2":
      return "**SSH-ready wait** (\`waitForSshReady\`, sshd takes ~1s to come up post-boot). Long-tail suggests sshd PerSourcePenaltyExemptList or entropy seeding is slow — or the underlying VM is still mid-boot.";
    case "diskReleased":
      return "**VZ disk release** (\`waitForDiskReleased\`, polls lsof on the bundle disk). Long tail suggests the guest didn't sysrq-halt cleanly — kernel write flush stalled, or sysrq is disabled in the kernel and we're falling through to a longer disk-release timeout.";
    case "waitRunning1":
    case "waitRunning2":
      return "**lume.waitForStatus** polling — points at lume @MainActor variance (W.6 / B.0.11.h). Cross-reference /tmp/lume-hang-\\*.txt samples for the actual stack.";
    case "clonefile":
      return "**APFS clonefile** of the base disk into the bundle. Should be sub-second (CoW); long-tail means clonefile isn't actually being used (different volumes? cross-volume copy?) or the base image is unusually large.";
    case "lumeCreate":
      return "**lume.create bundle** HTTP roundtrip. Long tail points at lume @MainActor variance during bundle creation.";
    default:
      return `**\`${phase}\`** — see createWell.ts mark() call sites for the surrounding code.`;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`analyze-create-profile — ${args.logs.length} log file(s)`);
  const profiles = await loadProfiles(args.logs, args.since);
  if (profiles.length === 0) {
    console.error("no profile entries found in the supplied logs");
    process.exit(1);
  }
  const a = analyze(profiles);
  console.log(`\n  total: ${a.total.count} samples`);
  console.log(
    `  total: min=${a.total.min}ms mean=${a.total.mean}ms p50=${a.total.p50}ms p95=${a.total.p95}ms p99=${a.total.p99}ms max=${a.total.max}ms`,
  );
  console.log(`  long-tail phase: ${a.longTailPhase} (p95 ${a.longTailContribution}ms)`);
  await writeFile(args.report, renderReport(args, profiles, a));
  console.log(`wrote ${args.report}`);
}

main().catch((e) => {
  console.error(`analyze-create-profile failed: ${(e as Error).message}`);
  process.exit(1);
});
