// Owns the lifecycle of `lume serve`. Pings before spawning so we don't
// double up if a developer already has lume running. On shutdown, kill what
// we spawned; leave external processes alone.

import { spawn, type Subprocess } from "bun";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../lib/log.ts";

const SPLITES_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LUME_BIN = join(SPLITES_ROOT, "bin", "lume");

const LUME_HOST = process.env.SPLITES_LUME_HOST ?? "127.0.0.1";
const LUME_PORT = Number(process.env.SPLITES_LUME_PORT ?? 7777);
const STARTUP_TIMEOUT_MS = 15_000;

export type LumeHandle = {
  // null = lume serve was already running externally; we don't own it.
  spawned: Subprocess | null;
  baseUrl: string;
};

export function lumeBaseUrl(): string {
  return `http://${LUME_HOST}:${LUME_PORT}`;
}

async function pingLume(timeoutMs = 500): Promise<boolean> {
  try {
    const r = await fetch(`${lumeBaseUrl()}/lume/host/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function ensureLumeServe(): Promise<LumeHandle> {
  if (await pingLume()) {
    log.info("lume serve already running; reusing", { baseUrl: lumeBaseUrl() });
    return { spawned: null, baseUrl: lumeBaseUrl() };
  }

  log.info("starting lume serve", { bin: LUME_BIN, port: LUME_PORT });
  const proc = spawn([LUME_BIN, "serve", "--port", String(LUME_PORT)], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });

  // Watchdog: if it exits while we're still alive, log it loudly. We don't
  // auto-restart in v1 — failures should be visible, not papered over.
  proc.exited.then((code) => {
    if (code !== 0) {
      log.error("lume serve exited unexpectedly", { code, pid: proc.pid });
    }
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(100);
    if (await pingLume()) {
      log.info("lume serve up", { pid: proc.pid });
      return { spawned: proc, baseUrl: lumeBaseUrl() };
    }
    if (proc.exitCode !== null) {
      throw new Error(`lume serve exited early with code ${proc.exitCode}`);
    }
  }

  proc.kill();
  throw new Error(`lume serve did not become reachable within ${STARTUP_TIMEOUT_MS}ms`);
}

export function stopLumeServe(handle: LumeHandle): void {
  if (!handle.spawned) {
    log.debug("lume serve was external; not stopping");
    return;
  }
  log.info("stopping spawned lume serve", { pid: handle.spawned.pid });
  handle.spawned.kill();
}
