// W.68 — Welld owns the lease entries for its wells.
//
// `/var/db/dhcpd_leases` is bootpd's source of truth for vmnet DHCP
// state. Pre-W.68, welld treated it as observed external state: read-
// only for IP lookups, mutated only via destroy/release paths. That
// model let drift accumulate: each new mutation surface (operator
// flush, failed bake, bootpd quirk, host reboot) was a new patch.
//
// Post-W.68, welld OWNS the entries for wells whose registry says
// `alive_running` / `alive_paused`. Lease file is a derived artifact:
// welld republishes its view on every alive transition AND on a
// periodic sweep. External mutations (a sudo flush, a stray
// /flush call that somehow bypassed W.67, bootpd write-quirk) heal
// automatically within the sweep window.
//
// Invariant: for every well whose runtime.state ∈ {alive_running,
// alive_paused} and runtime.ip is non-null, the lease file contains
// a matching entry. The publisher is the enforcer.
//
// Bounded: the publisher does NOT publish for pool members
// (hibernated, no active IP) and skips wells with null runtime.ip
// (lazy backfill: sweep reads via resolveWellIp + stamps + publishes
// on first encounter of a pre-W.68 well).

import { readLumeMac } from "./createWell.ts";
import { resolveWellIp } from "./dhcp.ts";
import { kickBootpd, publishLease } from "./dhcpHelper.ts";
import { log } from "./log.ts";
import { listWells, lumeNameOf } from "./registry.ts";
import {
  readRuntime,
  writeRuntime,
  type WellRuntime,
} from "./wellRuntime.ts";

// Pure: decide what to do for one well given its runtime + mac + a
// freshly-observed IP from the lease file. Exported for tests.
//
// Rules:
//   - alive_running / alive_paused → eligible
//   - any other state → skip (not running, no IP-invariant to enforce)
//   - no mac in bundle → skip (defense in depth; lease publish needs all 3)
//   - runtime.ip set → publish that (stamp wins over observation; this
//     is the whole point — if the lease file was nuked, the stamp is
//     the canonical source)
//   - runtime.ip null, observed IP found → publish + needsStamp:true
//     so the caller writes runtime.ip for next sweep
//   - neither → skip (lazy retry on next sweep)
export type PublishDecision =
  | { action: "publish"; ip: string; needsStamp: boolean }
  | { action: "skip"; reason: string };

export function decidePublishAction(
  runtime: WellRuntime | null,
  mac: string | null,
  observedIp: string | null,
): PublishDecision {
  if (!runtime) return { action: "skip", reason: "no-runtime" };
  if (runtime.state !== "alive_running" && runtime.state !== "alive_paused") {
    return { action: "skip", reason: `state=${runtime.state}` };
  }
  if (!mac) return { action: "skip", reason: "no-mac" };
  const stamped = runtime.ip ?? null;
  if (stamped) return { action: "publish", ip: stamped, needsStamp: false };
  if (observedIp) return { action: "publish", ip: observedIp, needsStamp: true };
  return { action: "skip", reason: "no-ip" };
}

export interface PublishResult {
  // Names of wells we successfully published entries for.
  published: string[];
  // Wells we considered (alive_running/alive_paused) but couldn't publish:
  // missing IP, missing MAC, or helper failure. Logged as warnings.
  skipped: Array<{ name: string; reason: string }>;
  // Total number of wells considered (alive_*).
  considered: number;
}

// Walk wellsRegistry, filter to alive wells, publish each entry. Best-
// effort: failures don't throw; they're recorded in `skipped` for the
// caller to surface via /healthz or logs.
//
// Lazy backfill: if a well's runtime.ip is null but resolveWellIp finds
// a current lease, the publisher stamps runtime.ip from the observation
// and publishes. This makes wells created pre-W.68 (no stamped IP)
// converge to the post-W.68 invariant on first sweep.
export async function publishAllAlive(): Promise<PublishResult> {
  const wells = await listWells();
  const published: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const well of wells) {
    const runtime = await readRuntime(well.name);
    if (
      !runtime ||
      (runtime.state !== "alive_running" &&
        runtime.state !== "alive_paused")
    ) {
      continue; // not in our managed set — skip without counting
    }
    const lumeName = lumeNameOf(well);
    const mac = await readLumeMac(lumeName);
    const observedIp = runtime.ip ? null : await resolveWellIp(well.name);
    const decision = decidePublishAction(runtime, mac, observedIp);
    if (decision.action === "skip") {
      skipped.push({ name: lumeName, reason: decision.reason });
      continue;
    }
    if (decision.needsStamp) {
      await writeRuntime(well.name, { ...runtime, ip: decision.ip });
      log.info("lease-publisher: backfilled ip", {
        name: well.name,
        ip: decision.ip,
      });
    }
    const r = await publishLease(lumeName, decision.ip, mac!);
    if (r.ok) {
      published.push(lumeName);
      continue;
    }
    if (r.reason === "not-installed") {
      skipped.push({ name: lumeName, reason: "helper-not-installed" });
      continue;
    }
    skipped.push({
      name: lumeName,
      reason: `helper-${r.reason ?? "unknown"} code=${r.exitCode ?? "?"}`,
    });
  }
  // W.70: batch-end kick. publishLease intentionally doesn't kick
  // bootpd per-call (was the cause of the 09:01Z incident — 96
  // SIGKILLs/min broke DHCP). One kick per sweep, only if we actually
  // wrote entries. No-op if helper isn't installed.
  if (published.length > 0) {
    const r = await kickBootpd();
    if (!r.ok && r.reason !== "not-installed") {
      log.warn("lease-publisher: kick-bootpd failed", {
        reason: r.reason,
        code: r.exitCode,
      });
    }
  }
  return {
    published,
    skipped,
    considered: published.length + skipped.length,
  };
}

// Single-well publish — used after createWell/wakeWell to immediately
// publish the new entry rather than waiting for the periodic sweep.
// Returns success/skip details so callers can log.
export async function publishOne(
  name: string,
): Promise<
  | { ok: true; lumeName: string }
  | { ok: false; reason: string }
> {
  const wells = await listWells();
  const well = wells.find((w) => w.name === name);
  if (!well) return { ok: false, reason: "well-not-in-registry" };
  const runtime = await readRuntime(name);
  if (!runtime) return { ok: false, reason: "no-runtime" };
  if (runtime.state !== "alive_running" && runtime.state !== "alive_paused") {
    return { ok: false, reason: `state=${runtime.state}` };
  }
  const lumeName = lumeNameOf(well);
  const mac = await readLumeMac(lumeName);
  if (!mac) return { ok: false, reason: "no-mac" };
  let ip = runtime.ip ?? null;
  if (!ip) {
    ip = await resolveWellIp(name);
    if (ip) {
      await writeRuntime(name, { ...runtime, ip });
    }
  }
  if (!ip) return { ok: false, reason: "no-ip" };
  const r = await publishLease(lumeName, ip, mac);
  if (r.ok) return { ok: true, lumeName };
  return {
    ok: false,
    reason: `helper-${r.reason ?? "unknown"}`,
  };
}

// Periodic-sweep state. Surface in /healthz so operators can see the
// invariant working. Updated atomically at the end of each sweep.
let lastPublishAt: string | null = null;
let lastResult: PublishResult | null = null;

export async function runPublishSweep(): Promise<PublishResult> {
  const result = await publishAllAlive();
  lastPublishAt = new Date().toISOString();
  lastResult = result;
  if (result.skipped.length > 0) {
    log.warn("lease-publisher: sweep had skips", {
      considered: result.considered,
      published: result.published.length,
      skipped: result.skipped.length,
      reasons: dedupReasons(result.skipped),
    });
  } else {
    log.debug("lease-publisher: sweep ok", {
      considered: result.considered,
      published: result.published.length,
    });
  }
  return result;
}

export interface PublisherHealth {
  last_publish_at: string | null;
  considered: number;
  published_count: number;
  skipped_count: number;
}

export function publisherHealth(): PublisherHealth {
  return {
    last_publish_at: lastPublishAt,
    considered: lastResult?.considered ?? 0,
    published_count: lastResult?.published.length ?? 0,
    skipped_count: lastResult?.skipped.length ?? 0,
  };
}

function dedupReasons(skipped: Array<{ reason: string }>): string[] {
  const seen = new Set<string>();
  for (const s of skipped) seen.add(s.reason);
  return Array.from(seen).slice(0, 5);
}

// Test seam — reset module-level state between tests.
export function _resetPublisherStateForTests(): void {
  lastPublishAt = null;
  lastResult = null;
}
