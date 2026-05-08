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
import { readDhcpLease } from "./dhcp.ts";
import { resumeWell, startWell, type StartResult } from "./lifecycle.ts";
import { clearPaused, isPaused } from "./paused.ts";
import { log } from "./log.ts";

// Pure-ish: takes a `start` function so it's testable without lume.
// Module-scoped Map so all callers across the daemon share the cache.
const startsInFlight = new Map<string, Promise<StartResult>>();

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
        const ip = (await readDhcpLease(name)) ?? null;
        return {
          alreadyRunning: false,
          woken: true,
          ip,
          bootMs: Date.now() - t0,
        };
      } catch (err) {
        // Lume returns "Virtual machine not running" when its in-memory
        // SharedVM cache lost track of this VM — happens when lume serve
        // crashed and was respawned. Welld's paused.ts persists across
        // the respawn, so we end up asking lume to resume something it
        // can't resume. Clear our paused state and force a fresh stop+
        // start cycle so the VM re-enters lume's cache cleanly.
        const msg = (err as Error).message;
        if (msg.includes("Virtual machine not running") || msg.includes("not running")) {
          log.warn("ensureRunning: resume failed; clearing paused state, forcing stop+start", {
            name,
            err: msg,
          });
          clearPaused(name);
          // Stop + start. lume.stop on a not-actually-running VM either
          // succeeds (it was running) or errors (already stopped) — we
          // ignore either since startWell will sort it.
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
