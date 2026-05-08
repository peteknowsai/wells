// Wake-on-demand. Some daemon paths (proxy traffic, exec, services PUT)
// require a running well. If the well is stopped, this helper starts
// it transparently before the request proceeds.
//
// Concurrency: multiple requests for the same stopped well arrive at
// the same time during a wake. We dedupe by caching the in-flight start
// promise per name, so all callers await the same start. `timeoutMs` is
// per-caller, not per-start — slow callers can give up while the start
// continues for others.

import { LumeClient } from "../engine/lume.ts";
import { resolveWellIp } from "./dhcp.ts";
import { resumeWell, startWell, type StartResult } from "./lifecycle.ts";
import { clearPaused, isPaused } from "./paused.ts";
import { log } from "./log.ts";

// Pure-ish: takes a `start` function so it's testable without lume.
// Module-scoped Map so all callers across the daemon share the cache.
const startsInFlight = new Map<string, Promise<StartResult>>();

// True when an error from lume.resume / lume.pause indicates the VM
// isn't in lume serve's in-memory SharedVM cache. Lume's response text
// is "Virtual machine not running: <name>" for these cases. The trigger
// is usually a lume serve crash + supervisor respawn — the cache is
// in-memory so it dies with the process. Welld's paused.ts persists
// across the respawn, so callers can hit this race even when the VM
// is otherwise fine. ensureRunning catches this and falls back to a
// fresh start.
export function isLumeNoCacheError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return msg.includes("Virtual machine not running");
}

export async function dedupedStart(
  name: string,
  start: (name: string) => Promise<StartResult>,
): Promise<StartResult> {
  let inFlight = startsInFlight.get(name);
  if (!inFlight) {
    inFlight = start(name).finally(() => startsInFlight.delete(name));
    startsInFlight.set(name, inFlight);
  }
  return await inFlight;
}

export interface EnsureRunningResult {
  alreadyRunning: boolean;
  woken: boolean;
  ip: string | null;
  bootMs: number | null;
}

export async function ensureRunning(
  name: string,
  timeoutMs: number = 10_000,
): Promise<EnsureRunningResult> {
  const lume = new LumeClient();
  const info = await lume.info(name).catch(() => null);
  if (info?.status === "running") {
    // Lume reports "running" for both running and CPU-paused VMs.
    // If welld paused this one, resume before declaring it ready.
    if (isPaused(name)) {
      const t0 = Date.now();
      try {
        await resumeWell(name);
        const ip = (await resolveWellIp(name)) ?? null;
        return {
          alreadyRunning: false,
          woken: true,
          ip,
          bootMs: Date.now() - t0,
        };
      } catch (err) {
        if (isLumeNoCacheError(err)) {
          // Lume's SharedVM cache lost the VM — see isLumeNoCacheError.
          // Recovery: clear our stale paused state and force a fresh
          // stop+start so the VM re-enters the cache cleanly.
          log.warn("ensureRunning: resume failed; clearing paused state, forcing stop+start", {
            name,
            err: (err as Error).message,
          });
          clearPaused(name);
          await lume.stop(name).catch(() => {});
          // Fall through to dedupedStart(startWell) below.
        } else {
          throw err;
        }
      }
    } else {
      return { alreadyRunning: true, woken: false, ip: null, bootMs: 0 };
    }
  }

  const startPromise = dedupedStart(name, startWell);
  try {
    const result = await Promise.race([
      startPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`wake timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return {
      alreadyRunning: false,
      woken: true,
      ip: result.ip,
      bootMs: result.bootMs,
    };
  } catch (e) {
    throw new Error(`wake-on-demand failed for well '${name}': ${(e as Error).message}`);
  }
}

// Test hook — clear the in-flight cache between cases.
export function _resetForTests(): void {
  startsInFlight.clear();
}
