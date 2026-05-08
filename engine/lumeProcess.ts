// Owns the lifecycle of `lume serve`. Pings before spawning so we don't
// double up if a developer already has lume running. On shutdown, kill what
// we spawned; leave external processes alone.
//
// Supervises after start: lume serve has a known crash mode where
// destroy-then-create cycles cause it to exit with SIGINT (code 130) — see
// the welld stress test in the conversation log. The supervisor pings
// every 2s and respawns on failure so a flaky lume doesn't poison welld
// for the cells team's birth flow. Externally-running lume processes are
// not supervised — caller's problem.

import { spawn, type Subprocess } from "bun";
import { openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../lib/log.ts";

const WELL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LUME_BIN = join(WELL_ROOT, "bin", "lume");
// Capture stderr so silent VM-start failures are visible when triaging.
// Path is fixed; rotate manually if it grows.
const LUME_LOG = "/tmp/lume-serve.log";

const LUME_HOST = process.env.WELL_LUME_HOST ?? "127.0.0.1";
const LUME_PORT = Number(process.env.WELL_LUME_PORT ?? 7777);
const STARTUP_TIMEOUT_MS = 15_000;
const SUPERVISOR_INTERVAL_MS = 5_000;
// Many consecutive misses before respawn. Lume blocks its HTTP actor
// during VZVirtualMachine spawn / stop and similar VZ-level operations.
// 30s wasn't enough — empirically observed pinned-IP forks hit ~30-35s
// of HTTP silence (lume busy spawning the VirtualMachine.xpc child +
// configuring VZ devices), and we were killing healthy lume mid-boot.
// Each respawn drops the in-flight VM because lume's SharedVM cache
// is in-process state. 24 misses × 5s = 2min — well past any
// observed blocking window, plenty of margin if VZ gets slower under
// memory pressure. If lume's actually dead, 2min is acceptable since
// nothing else makes progress until welld notices anyway.
const MISSES_BEFORE_RESPAWN = 24;
// Per-ping timeout. /lume/host/status can take 1-2s when lume is
// holding the actor lock for a long-running call.
const PING_TIMEOUT_MS = 2_000;

// Telemetry: sliding-window of respawn timestamps (epoch ms). The
// supervisor pushes on every respawn; lumeRespawnStats() reads it for
// /healthz and external observers. Pruned to the last hour on every
// stat read to keep memory bounded — at the worst-case observed rate
// (1/op under stress), a busy hour caps at ~120 entries.
const respawnTimestamps: number[] = [];
const RESPAWN_RETENTION_MS = 60 * 60 * 1000; // 1 hour
// Health threshold: more than 5 respawns in 5 minutes = "degraded".
// At that rate, lume is essentially down + the supervisor is keeping
// it bouncing — not what we want users routing real work through.
const DEGRADED_THRESHOLD_COUNT = 5;
const DEGRADED_THRESHOLD_WINDOW_MS = 5 * 60 * 1000;

function pruneOldRespawns(now: number): void {
  // Filter rather than shift-from-front — supervisor pushes are naturally
  // chronological in production but tests inject out of order, and the
  // array is bounded to ~120 entries so O(n) is fine.
  const cutoff = now - RESPAWN_RETENTION_MS;
  for (let i = respawnTimestamps.length - 1; i >= 0; i--) {
    if (respawnTimestamps[i]! < cutoff) respawnTimestamps.splice(i, 1);
  }
}

export interface LumeStats {
  totalRespawnsLastHour: number;
  respawnsLast5Min: number;
  respawnsLast1Min: number;
  // True when respawn rate crosses the degraded threshold. Surface
  // this in /healthz so cells team can detect lume in a bad place
  // before users do.
  degraded: boolean;
}

export function lumeRespawnStats(): LumeStats {
  const now = Date.now();
  pruneOldRespawns(now);
  const last5 = respawnTimestamps.filter((t) => t >= now - 5 * 60 * 1000).length;
  const last1 = respawnTimestamps.filter((t) => t >= now - 60 * 1000).length;
  return {
    totalRespawnsLastHour: respawnTimestamps.length,
    respawnsLast5Min: last5,
    respawnsLast1Min: last1,
    degraded: last5 >= DEGRADED_THRESHOLD_COUNT,
  };
}

// Test hooks — clear the counter and inject synthetic timestamps so
// the sliding-window logic is unit-testable without a real subprocess.
export function _resetRespawnStatsForTests(): void {
  respawnTimestamps.length = 0;
}

export function _pushRespawnForTests(timestampMs: number): void {
  respawnTimestamps.push(timestampMs);
}

export type LumeHandle = {
  // null = lume serve was already running externally; we don't own it
  // (and we don't supervise it).
  spawned: Subprocess | null;
  baseUrl: string;
  // Tear down the supervisor and kill the proc if owned. Idempotent.
  stop: () => void;
};

export function lumeBaseUrl(): string {
  return `http://${LUME_HOST}:${LUME_PORT}`;
}

async function pingLume(timeoutMs = PING_TIMEOUT_MS): Promise<boolean> {
  try {
    const r = await fetch(`${lumeBaseUrl()}/lume/host/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function spawnLume(): Subprocess {
  const fd = openSync(LUME_LOG, "a");
  return spawn([LUME_BIN, "serve", "--port", String(LUME_PORT)], {
    stdout: fd,
    stderr: fd,
    stdin: "ignore",
  });
}

async function waitUntilUp(proc: Subprocess): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(100);
    if (await pingLume()) return;
    if (proc.exitCode !== null) {
      throw new Error(`lume serve exited early with code ${proc.exitCode}`);
    }
  }
  try { proc.kill(); } catch {}
  throw new Error(`lume serve did not become reachable within ${STARTUP_TIMEOUT_MS}ms`);
}

export async function ensureLumeServe(): Promise<LumeHandle> {
  if (await pingLume()) {
    log.info("lume serve already running; reusing", { baseUrl: lumeBaseUrl() });
    return {
      spawned: null,
      baseUrl: lumeBaseUrl(),
      stop: () => {},
    };
  }

  log.info("starting lume serve", { bin: LUME_BIN, port: LUME_PORT, log: LUME_LOG });
  let current = spawnLume();
  await waitUntilUp(current);
  log.info("lume serve up", { pid: current.pid });

  // Supervisor: poll for liveness, respawn on death. We track the current
  // pid via a closure variable so the welld-facing baseUrl stays stable
  // across restarts (lume always rebinds to the same port).
  let stopped = false;
  let consecutiveMisses = 0;
  let respawning = false;

  const supervisor = setInterval(async () => {
    if (stopped || respawning) return;
    if (await pingLume()) {
      consecutiveMisses = 0;
      return;
    }
    consecutiveMisses++;
    if (consecutiveMisses < MISSES_BEFORE_RESPAWN) return;

    respawning = true;
    consecutiveMisses = 0;
    log.warn("lume serve unresponsive; respawning", { lastPid: current.pid });
    try { current.kill(); } catch {}
    try {
      current = spawnLume();
      await waitUntilUp(current);
      respawnTimestamps.push(Date.now());
      const stats = lumeRespawnStats();
      log.info("lume serve respawned", { pid: current.pid, ...stats });
      if (stats.degraded) {
        // Escalate: at this rate, lume is effectively bouncing and
        // user-facing operations are fragile. Surfaces in /healthz too.
        log.error("lume respawn rate crossed degraded threshold", {
          respawnsLast5Min: stats.respawnsLast5Min,
          threshold: DEGRADED_THRESHOLD_COUNT,
        });
      }
    } catch (err) {
      log.error("lume serve respawn failed; will retry", {
        err: (err as Error).message,
      });
    } finally {
      respawning = false;
    }
  }, SUPERVISOR_INTERVAL_MS);
  // Don't keep the event loop alive just for the supervisor.
  (supervisor as unknown as { unref?: () => void }).unref?.();

  return {
    spawned: current,
    baseUrl: lumeBaseUrl(),
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(supervisor);
      try { current.kill(); } catch {}
    },
  };
}

export function stopLumeServe(handle: LumeHandle): void {
  if (!handle.spawned) {
    log.debug("lume serve was external; not stopping");
    return;
  }
  log.info("stopping spawned lume serve");
  handle.stop();
}
