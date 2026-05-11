#!/usr/bin/env bun
// welld — the wells daemon. HTTP on :7878. Sprites-shaped REST.
// Phase 0+1: /healthz, supervises lume serve. Phase 8 lands the rest.

import { spawn, type Subprocess } from "bun";
import { rename } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import {
  ensureLumeServe,
  lumeRespawnStats,
  stopLumeServe,
  type LumeHandle,
} from "../engine/lumeProcess.ts";
import { LumeClient, type VMSummary } from "../engine/vwell.ts";
import { ensureStateDirs } from "../lib/state.ts";
import { rewriteSpritesAlias } from "../lib/spritesAlias.ts";
import { ensureToken } from "../lib/token.ts";
import { timingSafeEqual } from "../lib/timingSafe.ts";
import { apiError, unauthorized } from "../lib/apiResponse.ts";
import { countVzXpcProcesses } from "../lib/vzXpcCount.ts";
import { findWell, listWells, lumeNameOf, resolveLumeName } from "../lib/registry.ts";
import { dumpDhcpLeases, findWellByIp, resolveWellIp } from "../lib/dhcp.ts";
import { isBusy, markIdle } from "../lib/cellState.ts";
import { applyLifecycleState, parseLifecycleBody } from "../lib/cellLifecycle.ts";
import { probeImageSource } from "../lib/imageValidation.ts";
import { rinseGuest } from "../lib/rinseWell.ts";
import { waitForDiskReleased } from "../lib/diskReleased.ts";
import { bundleDiskPath } from "../engine/bundle.ts";
import { networkInterfaces } from "node:os";
import { PATHS } from "../lib/state.ts";
import { createWell, diskUsageBytes } from "../lib/createWell.ts";
import { destroyWell } from "../lib/destroy.ts";
import { drainAllPoolMembers, drainReadyPoolMembers, prunePoolZombies, startPoolFiller, triggerFillIfNeeded } from "../lib/poolFiller.ts";
import { listPoolMembers, poolSummary } from "../lib/poolRegistry.ts";
import { loadDefaults } from "../lib/defaults.ts";
import { defaultActuators, transitionWell } from "../lib/wellLifecycle.ts";
import {
  buildUpstreamWsInit,
  extractWellFromHost,
  proxyHttp,
  publicBase,
  resolveProxyTarget,
  type UpstreamWsInit,
  upstreamWsUrl,
} from "../lib/proxy.ts";
import {
  createCheckpoint,
  expireCheckpoint,
  listCheckpoints,
  parseDuration,
  restoreCheckpoint,
} from "../lib/checkpoints.ts";
import {
  CheckpointResource,
  CheckpointsListResponse,
  CreateWellRequest,
  DestroyResponse,
  ExecRequest,
  type ExecResponse,
  ImageResource,
  ImageSaveRequest,
  ImagesListResponse,
  PoolActionResponse,
  PoolListResponse,
  type PoolMemberResource,
  NetworkPolicyRequest,
  NetworkPolicyResponse,
  PatchWellRequest,
  ServiceDefinition,
  ServiceResource,
  ServicesListResponse,
  WellResource,
  WellsListResponse,
  type WellSummary,
  UrlUpdateRequest,
} from "../lib/schemas.ts";
import {
  imageMeta,
  listImages,
  removeImage,
  saveImage,
} from "../lib/imageStore.ts";
import { pullImage, pushImage, type R2LibraryConfig } from "../lib/imageLibrary.ts";
import {
  deleteService,
  getService,
  listServices,
  putService,
} from "../lib/services.ts";
import { updateWellAuth, updateWellAutoSleep } from "../lib/registry.ts";
import { shellEscape } from "../lib/shellEscape.ts";
import { clearLastTouched, getLastTouched, touch } from "../lib/idle.ts";
import { sampleActivity } from "../lib/activity.ts";
import { runWatchdogTick } from "../lib/watchdog.ts";
import { sweepDanglingLumeRun } from "../lib/lumeRunGc.ts";
import { ensureRunning } from "../lib/wake.ts";
import { closeSshControl, ensureSshMaster, sshControlArgs } from "../lib/sshControl.ts";
import { startBridgeDns } from "../lib/dns.ts";
import { log } from "../lib/log.ts";

const PORT = Number(process.env.WELL_PORT ?? 7878);
const VERSION = "0.1.0-pre";

const startedAt = new Date().toISOString();


await ensureStateDirs();

// Self-log to ~/.wells/welld.log when run interactively. Without this,
// `bun run daemon/welld.ts` from a terminal sends logs to stderr and
// nowhere else — if welld dies, the only artifact is whatever scrolled
// past the user's screen. Launchd-managed welld already redirects
// stderr to ~/.wells/welld.log via the plist, so we skip the tee in
// that case (would double-write every line).
if (process.stderr.isTTY && !process.env.WELL_LOG_FILE) {
  process.env.WELL_LOG_FILE = `${process.env.HOME}/.wells/welld.log`;
}

// Fail-soft on async leaks rather than dying silently. Without these
// handlers, an unhandled rejection anywhere (e.g., a fire-and-forget
// `proc.exited.then(...)` whose body throws) crashes the process.
// Cells team observed welld vanishing 14min into a single-cell birth;
// the manual launch left no log, so root-cause was unrecoverable.
// These handlers log + continue. If something genuinely needs to take
// the process down, throw from a request handler — those are caught
// by Bun's HTTP server and turned into 500s without killing welld.
process.on("unhandledRejection", (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.error("unhandled rejection — continuing", {
    err: err.message,
    stack: err.stack,
  });
});
process.on("uncaughtException", (err: Error) => {
  // Port-bind failures are fatal — Bun's serve() throws when the port
  // is taken, and without a bound socket welld can't actually serve
  // HTTP. The legacy "log + continue" left the process alive as a
  // zombie holding tokens / supervisor timers / state, which makes
  // the failure invisible to operators. Exit so a process supervisor
  // (launchctl, nohup loop, the operator's eyes) sees the bind error.
  if (/Failed to start server|EADDRINUSE/.test(err.message)) {
    log.error("uncaught exception — fatal port bind, exiting", {
      err: err.message,
    });
    process.exit(1);
  }
  log.error("uncaught exception — continuing", {
    err: err.message,
    stack: err.stack,
  });
});
const TOKEN = await ensureToken();
const lumeHandle: LumeHandle = await ensureLumeServe();

// Defensive resume on startup. Lume's status field doesn't distinguish
// paused from running; if welld was restarted while a cell was paused,
// the in-memory pause tracker is empty and lume reports "running", but
// the cell would actually be unresponsive. Walk all running VMs and
// fire resume — a no-op for already-running, unpauses anything stuck.
{
  const lume = new LumeClient();
  const all = await lume.list().catch(() => [] as VMSummary[]);
  for (const vm of all) {
    if (vm.status !== "running" || typeof vm.name !== "string") continue;
    await lume.resume(vm.name).catch(() => {
      // not paused = resume errors, fine. Anything else also fine —
      // worst case we miss the unstuck and the user notices a hang
      // and re-runs the cell.
    });
  }
}

// Sweep dangling `lume run` subprocesses left over from a previous
// welld run that crashed before destroy could clean up. The watchdog
// runs this every 30s, but a one-shot at startup catches stale state
// from previous runs immediately.
await sweepDanglingLumeRun().catch((err) =>
  log.warn("startup: lume-run gc failed", { err: (err as Error).message }),
);

function authorized(req: Request, urlForQuery?: URL): boolean {
  const header = req.headers.get("authorization") ?? "";
  const m = /^bearer\s+(\S+)\s*$/i.exec(header);
  if (m && timingSafeEqual(m[1]!, TOKEN)) return true;
  // Browser WS clients can't set custom headers — fall back to ?token=
  // for the WS upgrade path. Sprites does the same.
  const q = urlForQuery?.searchParams.get("token");
  if (q && timingSafeEqual(q, TOKEN)) return true;
  return false;
}


type WsSession =
  | { kind: "exec"; name: string; ssh: Subprocess<"pipe", "pipe", "pipe"> | null }
  | {
      kind: "proxy";
      well: string;
      upstreamUrl: string;
      // Headers + subprotocols carried from the original client upgrade.
      // Without these, the cell-side `/agent` (or anything with a bearer
      // check / subprotocol negotiation) sees a naked handshake and closes
      // — Bun then emits onerror, which surfaces as 1011 to the client.
      upstreamInit: UpstreamWsInit;
      upstream: WebSocket | null;
      queue: (string | Buffer)[];
    };

const server = Bun.serve<WsSession>({
  port: PORT,
  hostname: "127.0.0.1",
  // Default is 10s; our long-pole endpoints (create ~30s, restore ~15s,
  // stop ~12s) all blow past it. 255 is Bun's max — about 4 min, which
  // accommodates a slow guest cloud-init without cutting clients off.
  idleTimeout: 255,
  async fetch(req, srv) {
    const url = new URL(req.url);

    // Path alias: /v1/sprites/... → /v1/wells/.... Cells (and any other
    // sprites-shaped client) doesn't know we exist; this rewrite at the
    // top of fetch() means everything downstream sees the canonical path.
    // See lib/spritesAlias.ts for the rule + tests.
    url.pathname = rewriteSpritesAlias(url.pathname);

    // Reverse-proxy branch — when the Host header matches the configured
    // public base (e.g. "pete.wells.cells.md" with WELL_PUBLIC_BASE
    // = "wells.cells.md"), forward the request to the well's guest:8080.
    // This is what cloudflared dials. No bearer auth on this path — the
    // well's own app handles auth.
    const base = publicBase();
    if (base) {
      const well = extractWellFromHost(req.headers.get("host"), base);
      if (well) {
        // Wake-on-demand: if the well is registered but stopped, start
        // it before resolving the proxy target. Caller pays a one-time
        // ~5s on the first request after a stop; subsequent ones are fast.
        if (await findWell(well)) {
          try {
            await ensureRunning(well, 10_000);
          } catch (err) {
            return new Response(`wake failed: ${(err as Error).message}\n`, {
              status: 504,
              headers: { "content-type": "text/plain" },
            });
          }
        }
        const target = await resolveProxyTarget(well);
        if (!target) {
          return new Response(`well '${well}' not found or not running\n`, {
            status: 502,
            headers: { "content-type": "text/plain" },
          });
        }
        // Per-well auth gate: when the record's `auth` is "well", the
        // proxy demands a Bearer token before forwarding. "public" mode
        // (cells's hatched cells) skips auth entirely.
        if (target.auth === "well" && !authorized(req, url)) {
          return unauthorized();
        }
        // Proxy traffic counts as activity for the autosleep watchdog.
        touch(target.well);
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const ok = srv.upgrade(req, {
            data: {
              kind: "proxy",
              well: target.well,
              upstreamUrl: upstreamWsUrl(target, url),
              upstreamInit: buildUpstreamWsInit(req),
              upstream: null,
              queue: [],
            } satisfies WsSession,
          });
          if (ok) return undefined;
          return new Response("ws upgrade failed\n", { status: 400 });
        }
        return proxyHttp(req, target);
      }
    }

    // /healthz is always public — used by bootstrap scripts and process
    // managers that don't have the token yet.
    if (req.method === "GET" && url.pathname === "/healthz") {
      const stats = lumeRespawnStats();
      // VZ XPC orphan check (B.0.7.f): count host processes whose
      // exec path matches Apple's VZ XPC service marker. Surfaced
      // here so external pollers (cells team's birth flow, doctor
      // CLI) can detect orphans without spawning their own ps.
      const vzXpcCount = await countVzXpcProcesses().catch(() => -1);
      // Pool summary so cells team can predict whether the next `well
      // create` will pool-adopt (~2-3s, ready_count > 0 + same default
      // sizing) or fall through to fresh-create (~12-15s). target_size
      // sourced from defaults.pool_size; tolerate a defaults read miss
      // by treating target as 0 — the registry counts are still accurate.
      const poolDefault = await loadDefaults()
        .then((d) => d.pool_size ?? 0)
        .catch(() => 0);
      const pool = await poolSummary(poolDefault).catch(() => ({
        target_size: poolDefault,
        ready_count: 0,
        provisioning_count: 0,
        warming_count: 0,
        adopting_count: 0,
      }));
      // vmnet bootpd leases (`/var/db/dhcpd_leases`). Cells team
      // 2026-05-11: aborted bake/create flows leak lease entries
      // here, and vmnet's bootpd never garbage-collects — eventually
      // the IP pool fills up and new wells time out at the DHCP
      // step. Surface total + orphans (leases whose name isn't a
      // registered well) so operators can see the bloat without
      // sudo'ing into /var/db/dhcpd_leases by hand. Actual flush
      // needs root — see `scripts/flush-dhcp-leases.sh`.
      const vmnetLeases = await dumpDhcpLeases().catch(() => []);
      const wellNames = new Set(
        (await listWells().catch(() => [])).map((r) => r.name),
      );
      // A lease is orphan if its name is set + not in the registry.
      // Null-named leases (DUID form) are excluded — we can't tell
      // which well they belong to without MAC matching, and bootpd's
      // own GC handles those eventually.
      const vmnetOrphans = vmnetLeases.filter(
        (l) => l.name !== null && !wellNames.has(l.name),
      );
      return Response.json({
        ok: true,
        version: VERSION,
        started_at: startedAt,
        lume: {
          base_url: lumeHandle.baseUrl,
          owned: lumeHandle.spawned !== null,
          respawns_last_hour: stats.totalRespawnsLastHour,
          respawns_last_5min: stats.respawnsLast5Min,
          respawns_last_1min: stats.respawnsLast1Min,
        },
        // Count of `Virtualization.VirtualMachine` processes alive
        // on the host. Compare against lume's vm_count to detect
        // orphans. -1 means the ps walk failed (don't surface as 0,
        // which would falsely look like "no orphans").
        vz_xpc_count: vzXpcCount,
        // Degraded = lume's been bouncing fast enough that user ops are
        // fragile. False under normal operation. Cells team's birth flow
        // can poll this and back off if it flips.
        degraded: stats.degraded,
        pool,
        // vmnet's DHCP leases live in /var/db/dhcpd_leases. `total`
        // is the full lease count (including legit running wells +
        // unrecognized DUID-form entries). `orphan_count` is leases
        // whose `name` is set but isn't in welld's registry — those
        // are the zombies safe to flush. `orphans` lists the first
        // 50 by name for surface visibility. To actually flush,
        // operator runs `scripts/flush-dhcp-leases.sh` (requires sudo).
        vmnet_leases: {
          total: vmnetLeases.length,
          orphan_count: vmnetOrphans.length,
          orphans: vmnetOrphans
            .slice(0, 50)
            .map((l) => ({ name: l.name, ip: l.ip })),
        },
      });
    }

    // WS upgrade — authorize before upgrading, then attach session data.
    const wsExec = /^\/v1\/wells\/([^/]+)\/exec$/.exec(url.pathname);
    if (wsExec && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!authorized(req, url)) return unauthorized();
      const name = decodeURIComponent(wsExec[1]!);
      touch(name);
      // Wake-on-demand: WS exec needs the well running.
      if (await findWell(name)) {
        try {
          await ensureRunning(name, 10_000);
        } catch (err) {
          return new Response(`wake failed: ${(err as Error).message}\n`, {
            status: 504,
          });
        }
      }
      const ok = srv.upgrade(req, {
        data: { kind: "exec", name, ssh: null } satisfies WsSession,
      });
      if (ok) return undefined;
      return new Response("ws upgrade failed\n", { status: 400 });
    }

    if (!authorized(req, url)) return unauthorized();

    // Authed activity on a per-well path counts as a touch for the
    // autosleep watchdog. The regex captures every `/v1/wells/{n}/...`
    // (and the bare `/v1/wells/{n}`) — list/whoami don't match and
    // correctly don't bump anything.
    const touchMatch = /^\/v1\/wells\/([^/]+)/.exec(url.pathname);
    if (touchMatch) touch(decodeURIComponent(touchMatch[1]!));

    // Synchronous HTTP exec — same path as WS, distinguished by upgrade
    // header. Cells's `deliberate` extension uses this for one-shot bash
    // calls that buffer output. Body: `{command: [...]}`. Response:
    // `{exit_code, stdout, stderr, truncated?}`.
    if (wsExec && req.method === "POST") {
      const name = decodeURIComponent(wsExec[1]!);
      return handleHttpExec(name, req);
    }

    if (req.method === "GET" && url.pathname === "/v1/whoami") {
      return Response.json({ ok: true, scope: "welld" });
    }

    if (url.pathname === "/v1/wells") {
      if (req.method === "GET") return handleListWells();
      if (req.method === "POST") return handleCreateWell(req);
    }

    // Image store — saved disk snapshots. Lives at /v1/wells/images/...
    // (must match before the bare-name route below, otherwise GET on
    // .../images would dispatch to handleGetWell("images") and 404.)
    if (url.pathname === "/v1/wells/images") {
      if (req.method === "GET") return handleListImages();
      if (req.method === "POST") return handleSaveImage(req);
    }

    const imageOne = /^\/v1\/wells\/images\/([^/]+)$/.exec(url.pathname);
    if (imageOne) {
      const name = decodeURIComponent(imageOne[1]!);
      if (req.method === "GET") return handleGetImage(name);
      if (req.method === "DELETE") return handleDeleteImage(name);
    }

    // W.4 — image library push. POST /v1/wells/images/<name>/push
    // streams the local image to R2. Caller passes R2 creds in the
    // body (per-image override) or relies on welld's WELL_R2_LIBRARY_*
    // env (per-Mac default).
    const imagePush = /^\/v1\/wells\/images\/([^/]+)\/push$/.exec(url.pathname);
    if (imagePush && req.method === "POST") {
      const name = decodeURIComponent(imagePush[1]!);
      return handlePushImage(name, req);
    }

    // W.5 — image library pull. POST /v1/wells/images/<name>/pull
    // fetches the image from R2. Same config plumbing as push.
    const imagePull = /^\/v1\/wells\/images\/([^/]+)\/pull$/.exec(url.pathname);
    if (imagePull && req.method === "POST") {
      const name = decodeURIComponent(imagePull[1]!);
      return handlePullImage(name, req);
    }

    // A.1.5 — pool visibility + control. Comes before the
    // /v1/wells/:name catch so `/pool` doesn't dispatch to
    // handleGetWell("pool").
    if (url.pathname === "/v1/wells/pool" && req.method === "GET") {
      return handleListPool();
    }
    if (url.pathname === "/v1/wells/pool/refill" && req.method === "POST") {
      return handleRefillPool();
    }
    if (url.pathname === "/v1/wells/pool/drain" && req.method === "POST") {
      return handleDrainPool(url.searchParams.get("all") === "true");
    }

    const m = /^\/v1\/wells\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const name = decodeURIComponent(m[1]!);
      if (req.method === "GET") return handleGetWell(name);
      if (req.method === "DELETE") return handleDestroyWell(name);
      if (req.method === "PATCH") return handlePatchWell(name, req);
    }

    const action = /^\/v1\/wells\/([^/]+)\/(start|stop)$/.exec(url.pathname);
    if (action && req.method === "POST") {
      const name = decodeURIComponent(action[1]!);
      const verb = action[2] as "start" | "stop";
      return handleLifecycle(name, verb);
    }

    // wells: hibernation routes — POST /v1/wells/{n}/hibernate dumps
    // the VM's RAM+CPU+device state to ~/.wells/vms/{n}/hibernate.bin
    // and stops the VM. POST /v1/wells/{n}/wake restores from that
    // file. Combined with auto-sleep this is the "freeze idle cells
    // to reclaim RAM" path — see docs/lifecycle.md.
    const hib = /^\/v1\/wells\/([^/]+)\/(hibernate|wake)$/.exec(url.pathname);
    if (hib && req.method === "POST") {
      const name = decodeURIComponent(hib[1]!);
      const verb = hib[2] as "hibernate" | "wake";
      return handleHibernation(name, verb);
    }

    const cps = /^\/v1\/wells\/([^/]+)\/checkpoints$/.exec(url.pathname);
    if (cps) {
      const name = decodeURIComponent(cps[1]!);
      if (req.method === "POST") return handleCreateCheckpoint(name, req);
      if (req.method === "GET") return handleListCheckpoints(name);
    }

    const restore = /^\/v1\/wells\/([^/]+)\/checkpoints\/([^/]+)\/restore$/.exec(url.pathname);
    if (restore && req.method === "POST") {
      const name = decodeURIComponent(restore[1]!);
      const id = decodeURIComponent(restore[2]!);
      const fromR2 = url.searchParams.get("from_r2") === "true";
      return handleRestoreCheckpoint(name, id, fromR2);
    }

    const cpDelete = /^\/v1\/wells\/([^/]+)\/checkpoints\/([^/]+)$/.exec(url.pathname);
    if (cpDelete && req.method === "DELETE") {
      const name = decodeURIComponent(cpDelete[1]!);
      const id = decodeURIComponent(cpDelete[2]!);
      return handleExpireCheckpoint(name, id);
    }

    const policy = /^\/v1\/wells\/([^/]+)\/policy\/network$/.exec(url.pathname);
    if (policy) {
      const name = decodeURIComponent(policy[1]!);
      if (req.method === "POST") return handleNetworkPolicy(name, req);
      if (req.method === "GET") return handleGetNetworkPolicy(name);
    }

    const services = /^\/v1\/wells\/([^/]+)\/services$/.exec(url.pathname);
    if (services && req.method === "GET") {
      return handleListServices(decodeURIComponent(services[1]!));
    }

    const service = /^\/v1\/wells\/([^/]+)\/services\/([^/]+)$/.exec(url.pathname);
    if (service) {
      const name = decodeURIComponent(service[1]!);
      const id = decodeURIComponent(service[2]!);
      if (req.method === "PUT") return handlePutService(name, id, req);
      if (req.method === "DELETE") return handleDeleteService(name, id);
      if (req.method === "GET") return handleGetService(name, id);
    }

    const urlRoute = /^\/v1\/wells\/([^/]+)\/url$/.exec(url.pathname);
    if (urlRoute && req.method === "PUT") {
      return handleUpdateUrl(decodeURIComponent(urlRoute[1]!), req);
    }

    return new Response("not found\n", { status: 404 });
  },
  websocket: {
    async open(ws) {
      const d = ws.data;
      if (d.kind === "proxy") {
        // Open the upstream WS and bridge frames bidirectionally. Frames
        // received before upstream is open get queued. Headers + protocols
        // come from the original client upgrade — see WsSession.upstreamInit.
        const out = new WebSocket(d.upstreamUrl, d.upstreamInit);
        out.binaryType = "arraybuffer";
        out.onopen = () => {
          d.upstream = out;
          for (const f of d.queue) out.send(f);
          d.queue = [];
        };
        out.onmessage = (ev) => {
          try {
            ws.send(ev.data as string | ArrayBuffer | Buffer);
          } catch {}
        };
        out.onclose = () => ws.close();
        out.onerror = () => ws.close(1011);
        return;
      }
      // Exec session — the client awaits a "ready" frame and then sends
      //   {type:"start", cmd:["bash","-c","echo hi"], tty?:false}
      ws.send(JSON.stringify({ type: "ready" }));
    },
    async message(ws, raw) {
      const data = ws.data;
      // Long-running WS sessions (exec, proxy) keep the well alive
      // — touch on every frame so the watchdog doesn't stop it mid-call.
      touch(data.kind === "proxy" ? data.well : data.name);
      if (data.kind === "proxy") {
        if (data.upstream && data.upstream.readyState === WebSocket.OPEN) {
          data.upstream.send(raw as string | ArrayBuffer | Buffer);
        } else {
          data.queue.push(raw as string | Buffer);
        }
        return;
      }
      let frame: { type?: string; cmd?: unknown; tty?: unknown; data?: unknown; user?: unknown };
      try {
        frame = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "expected JSON frame" }));
        return;
      }

      if (!data.ssh) {
        if (frame.type !== "start" || !Array.isArray(frame.cmd) || frame.cmd.some((x) => typeof x !== "string")) {
          ws.send(JSON.stringify({ type: "error", message: "first frame must be {type:'start', cmd:[string,...]}" }));
          ws.close(1002);
          return;
        }
        const record = await findWell(data.name);
        if (!record) {
          ws.send(JSON.stringify({ type: "error", message: `well '${data.name}' not found` }));
          ws.close(1011);
          return;
        }
        const ip = await resolveWellIp(data.name);
        if (!ip) {
          ws.send(JSON.stringify({ type: "error", message: `well '${data.name}' has no DHCP lease` }));
          ws.close(1011);
          return;
        }

        const tty = frame.tty === true;
        // Default to the `well` agent user; clients can override via
        // {"user":"ubuntu"} in the start frame. SSH always lands as
        // `well` (only firstboot-set-up SSH user beyond `ubuntu`),
        // and we sudo-switch when the caller wants something else
        // — see the matching pattern in handleExec for rationale.
        const wsUser =
          typeof frame.user === "string" && frame.user.length > 0 ? frame.user : "well";
        await ensureSshMaster({
          name: data.name,
          ip,
          user: "well",
          keyPath: PATHS.vmSshKey(data.name),
        });
        const innerCmd = (frame.cmd as string[]).map(shellEscape).join(" ");
        const remoteCmd =
          wsUser === "well"
            ? innerCmd
            : `sudo -n -u ${shellEscape(wsUser)} bash -c ${shellEscape(innerCmd)}`;
        const sshArgs = [
          "ssh",
          ...sshControlArgs(data.name),
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          "-o", "LogLevel=ERROR",
          "-i", PATHS.vmSshKey(data.name),
          ...(tty ? ["-tt"] : []),
          `well@${ip}`,
          remoteCmd,
        ];
        const proc = spawn(sshArgs, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        data.ssh = proc;

        // Drain both pipes BEFORE sending the exit frame — proc.exited
        // resolves the moment the kernel reaps the process, but ssh's
        // stdout/stderr pipes can still have buffered bytes we haven't
        // forwarded. Send exit only once those reads are done.
        const pipes = [
          pipeStreamToWs(proc.stdout, ws, "stdout"),
          pipeStreamToWs(proc.stderr, ws, "stderr"),
        ];
        proc.exited
          .then(async (code) => {
            await Promise.allSettled(pipes);
            try { ws.send(JSON.stringify({ type: "exit", code })); } catch {}
            try { ws.close(); } catch {}
          })
          .catch((err) => {
            log.warn("exec ws cleanup threw", { err: (err as Error).message });
          });
        return;
      }

      // Subsequent frames are stdin from the client.
      if (frame.type === "stdin" && typeof frame.data === "string") {
        const bytes = Buffer.from(frame.data, "base64");
        data.ssh.stdin.write(bytes);
      } else if (frame.type === "stdin_close") {
        data.ssh.stdin.end();
      } else {
        ws.send(JSON.stringify({ type: "error", message: `unexpected frame type '${frame.type}'` }));
      }
    },
    close(ws) {
      const d = ws.data;
      if (d.kind === "proxy") {
        try { d.upstream?.close(); } catch {}
        return;
      }
      // Client hung up — kill the ssh subprocess so we don't leak it.
      d.ssh?.kill();
    },
  },
});

async function pipeStreamToWs(
  stream: ReadableStream<Uint8Array>,
  ws: Bun.ServerWebSocket<WsSession>,
  channel: "stdout" | "stderr",
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      try {
        ws.send(JSON.stringify({ type: channel, data: Buffer.from(value).toString("base64") }));
      } catch {
        // ws closed mid-stream; bail.
        return;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}


async function handleListWells(): Promise<Response> {
  const wells = await listWells();
  const lume = new LumeClient();
  const lumeList = await lume.list().catch(() => [] as VMSummary[]);
  const lumeByName = new Map(lumeList.map((v) => [v.name, v]));

  const base = publicBase();
  const rows: WellSummary[] = await Promise.all(
    wells.map(async (s) => {
      const lv = lumeByName.get(s.name);
      const status =
        typeof lv?.status === "string"
          ? (lv.status as "running" | "stopped")
          : "missing";
      const ip = await resolveWellIp(s.name);
      return {
        name: s.name,
        status,
        url: base ? `https://${s.name}.${base}` : null,
        ip,
        created_at: s.created_at,
        last_running_at: null,  // tracked when stop/start mutates the registry.
      };
    }),
  );

  const body = { wells: rows };
  // Self-validate before responding — catches drift between the engine
  // shape and the API shape early. In prod this is a should-never-fire
  // guardrail; in dev it's a fast feedback loop on schema edits.
  if (!Value.Check(WellsListResponse, body)) {
    log.error("response shape failed validation", {
      route: "/v1/wells",
      errors: [...Value.Errors(WellsListResponse, body)].slice(0, 3),
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}

async function buildWellResource(name: string) {
  const record = await findWell(name);
  if (!record) return null;
  const lume = new LumeClient();
  const lumeInfo = await lume.info(lumeNameOf(record)).catch(() => null);
  const status =
    typeof lumeInfo?.status === "string"
      ? (lumeInfo.status as "running" | "stopped")
      : "missing";
  const ip = await resolveWellIp(name);
  const diskUsed = await diskUsageBytes(name);
  const base = publicBase();
  return {
    name: record.name,
    uuid: record.uuid,
    status,
    url: base ? `https://${record.name}.${base}` : null,
    ip,
    created_at: record.created_at,
    last_running_at: null,
    cpu: record.cpu,
    memory: record.memory,
    disk_size: record.disk_size,
    disk_used_bytes: diskUsed,
    ...(record.auto_sleep_seconds !== undefined
      ? { auto_sleep_seconds: record.auto_sleep_seconds }
      : {}),
  };
}

function wellResourceResponse(body: unknown, route: string): Response {
  if (!Value.Check(WellResource, body)) {
    log.error("response shape failed validation", {
      route,
      errors: [...Value.Errors(WellResource, body)].slice(0, 3),
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}

async function handleGetWell(name: string): Promise<Response> {
  const body = await buildWellResource(name);
  if (!body) return apiError(404, "not_found", `well '${name}' not found`);
  return wellResourceResponse(body, `/v1/wells/${name}`);
}

async function handleLifecycle(
  name: string,
  verb: "start" | "stop",
): Promise<Response> {
  const record = await findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);

  try {
    // For start, use ensureRunning so a paused/hibernating well
    // resolves to alive_running transparently. The daemon treats
    // POST /start as "make this well alive" — the cells team's
    // wake-on-traffic contract (2026-05-08) and `well exec`
    // automation both depend on it being idempotent across
    // stopped/paused/hibernating/running states.
    if (verb === "start") {
      await ensureRunning(name, 60_000);
    } else {
      // stop routes through the state machine: lock + dispatch +
      // actuate + write runtime. Idempotent (stop-on-stopped is a
      // noop, no lume call).
      await transitionWell(name, "stop", defaultActuators);
    }
  } catch (e) {
    return apiError(500, `${verb}_failed`, (e as Error).message);
  }

  const body = await buildWellResource(name);
  if (!body) return apiError(500, "vanished", `well '${name}' disappeared mid-${verb}`);
  return wellResourceResponse(body, `/v1/wells/${name}/${verb}`);
}

async function handleHibernation(
  name: string,
  verb: "hibernate" | "wake",
): Promise<Response> {
  const record = await findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);

  try {
    // Both verbs go through the state machine (B.0.7.g). The
    // dispatcher treats hibernate-on-hibernating and wake-on-running
    // as no-op success — callers don't have to branch on current
    // state. Failed restore writes error_orphaned (in wakeWell, on
    // recipe drift) rather than ambiguous stopped.
    await transitionWell(name, verb, defaultActuators);
  } catch (e) {
    return apiError(500, `${verb}_failed`, (e as Error).message);
  }

  const body = await buildWellResource(name);
  if (!body) return apiError(500, "vanished", `well '${name}' disappeared mid-${verb}`);
  return wellResourceResponse(body, `/v1/wells/${name}/${verb}`);
}

async function handleCreateWell(req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(CreateWellRequest, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(CreateWellRequest, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const body = parsed as CreateWellRequest;

  if (body.from_image && body.from_thaw) {
    return apiError(400, "bad_request", "from_image and from_thaw are mutually exclusive");
  }

  // Belt-and-suspenders: wipe any stale lastTouched entry for this
  // name before create. Destroy clears it too (see handleDestroyWell),
  // but stale entries can survive welld crashes or out-of-band cleanup.
  clearLastTouched(body.name);

  try {
    if (body.from_thaw) {
      // W.26 — thaw path. No boot; mirror src bundle + restoreState.
      // Sizing/r2/env from the request are IGNORED here because
      // src's saved state encodes its own. Caller's create-time
      // config doesn't apply to a clone of an already-running VM.
      const { thawFrom } = await import("../lib/thaw.ts");
      await thawFrom({ srcName: body.from_thaw, newName: body.name });
    } else {
      await createWell({
        name: body.name,
        cpu: body.cpu,
        memory: body.memory,
        disk: body.disk,
        ...(body.r2 ? { r2: body.r2 } : {}),
        ...(body.env ? { env: body.env } : {}),
        ...(body.from_image ? { fromImage: body.from_image } : {}),
      });
    }
  } catch (e) {
    return apiError(400, "create_failed", (e as Error).message);
  }

  const resource = await buildWellResource(body.name);
  if (!resource) {
    return apiError(500, "vanished", `well '${body.name}' missing post-create`);
  }
  if (!Value.Check(WellResource, resource)) {
    log.error("response shape failed validation", { route: "POST /v1/wells" });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(resource, { status: 201 });
}

async function handleListImages(): Promise<Response> {
  // W.25 (cells team) — `cmdBake` calls this endpoint with a `.catch(() => null)`
  // wrapper to detect existing-image conflicts before saving. Pre-fix, ANY
  // single image with a contract-drift shape (e.g., a partial `meta.json`,
  // an in-progress save, an old field name) tripped the response-level
  // schema check and returned 500 — the whole list disappeared and bake's
  // `--force` delete branch silently skipped, so save then 409'd with
  // "image already exists." Now: validate per-entry, drop + log the
  // malformed ones, return the rest. The list endpoint is tolerant of
  // partial state.
  const images = await listImages();
  const valid: ImageResource[] = [];
  for (const meta of images) {
    if (Value.Check(ImageResource, meta)) {
      valid.push(meta);
    } else {
      const errors = [...Value.Errors(ImageResource, meta)].slice(0, 3);
      log.warn("listImages: dropping malformed image meta", {
        name: (meta as { name?: unknown })?.name ?? "(unknown)",
        errors: errors.map((e) => `${e.path}: ${e.message}`),
      });
    }
  }
  const body: ImagesListResponse = { images: valid };
  return Response.json(body);
}

// A.1.5 — pool visibility. Reports current members, target depth (from
// defaults.pool_size), and ready count. Cells team uses this to decide
// whether to opt into pool-served creates and to monitor depth.
async function handleListPool(): Promise<Response> {
  const [members, defaults] = await Promise.all([
    listPoolMembers(),
    loadDefaults(),
  ]);
  const resourceMembers: PoolMemberResource[] = members.map((m) => ({
    name: m.name,
    source_image: m.source_image,
    cpu: m.cpu,
    memory: m.memory,
    disk_size: m.disk_size,
    state: m.state,
    created_at: m.created_at,
    ...(m.ready_at ? { ready_at: m.ready_at } : {}),
  }));
  const body = {
    members: resourceMembers,
    target_size: defaults.pool_size,
    ready_count: members.filter((m) => m.state === "ready").length,
  };
  if (!Value.Check(PoolListResponse, body)) {
    log.error("response shape failed validation", { route: "GET /v1/wells/pool" });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}

// A.1.5 — kick the background filler. Idempotent: if a fill is
// already in flight or pool depth is at target, this is a no-op
// (returns ok=true with a message describing why nothing happened).
// Cells team uses this to force-warm before a known burst of creates.
async function handleRefillPool(): Promise<Response> {
  triggerFillIfNeeded();
  const body: PoolActionResponse = {
    ok: true,
    message: "fill triggered (no-op if depth at target or fill in flight)",
  };
  return Response.json(body);
}

// A.1.5 — wipe pool members. Default scope: `ready` only; in-flight
// (provisioning/warming/adopting) get left alone so concurrent operations
// aren't yanked. With `?all=true` (W.23 — cells team) the drain includes
// every member regardless of state, useful for clearing zombie entries
// after a daemon crash. Caller's job to set defaults.pool_size=0 first
// if they want to keep depth at zero past the housekeeping timer.
async function handleDrainPool(all: boolean): Promise<Response> {
  const count = all ? await drainAllPoolMembers() : await drainReadyPoolMembers();
  const message = all
    ? `drained ${count} member(s) (all states); set defaults.pool_size=0 first if you want to keep depth at zero`
    : `drained ${count} ready member(s); set defaults.pool_size=0 first if you want to keep depth at zero`;
  const body: PoolActionResponse = { ok: true, message, count };
  return Response.json(body);
}

async function handleGetImage(name: string): Promise<Response> {
  const meta = await imageMeta(name);
  if (!meta) return apiError(404, "not_found", `image '${name}' not found`);
  if (!Value.Check(ImageResource, meta)) {
    log.error("response shape failed validation", {
      route: `GET /v1/wells/images/${name}`,
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(meta);
}

async function handleSaveImage(req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(ImageSaveRequest, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(ImageSaveRequest, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const body = parsed as ImageSaveRequest;

  // Two flows: validate (probe-then-save, source must be running) or
  // direct save (current behavior, source must be stopped). Direct
  // save preserves clonefile-of-cold-disk safety; the validate flow
  // SSHes in for fork-time checks then stops cleanly before clonefile.
  const lume = new LumeClient();
  const info = await lume.info(await resolveLumeName(body.from_well)).catch(() => null);

  // Default rinse=true when validate=true (the typical bake flow).
  // Direct save (validate=false) keeps rinse opt-in, since the well
  // is already stopped and we can't SSH in.
  const wantRinse = body.rinse ?? body.validate === true;
  let didRinse = false;

  if (body.validate === true) {
    if (!info || info.status !== "running") {
      return apiError(
        400,
        "validate_requires_running",
        `validate=true needs '${body.from_well}' running (we SSH in for fork-time checks); start the well first`,
      );
    }
    const ip = await resolveWellIp(body.from_well);
    if (!ip) {
      return apiError(
        500,
        "no_ip",
        `well '${body.from_well}' is running but has no DHCP lease — can't SSH for validation`,
      );
    }
    const reasons = await probeImageSource(
      ip,
      PATHS.vmSshKey(body.from_well),
      10_000,
    );
    if (reasons.length > 0) {
      return apiError(
        400,
        "image_invalid_source",
        `source guest is missing fork-time prerequisites: ${reasons.join("; ")}`,
      );
    }
    if (wantRinse) {
      // The rinse script wipes authorized_keys + initiates shutdown
      // in the same SSH session. We can't shutdown afterwards (no
      // way back in), so rinse-and-go.
      log.info("save: rinsing guest + shutting down", {
        well: body.from_well,
      });
      try {
        await rinseGuest({
          ip,
          keyPath: PATHS.vmSshKey(body.from_well),
        });
        didRinse = true;
      } catch (e) {
        return apiError(500, "rinse_failed", (e as Error).message);
      }
      // Wait for VZ to fully release the bundle disk. Without this,
      // clonefile races against the still-flushing guest.
      try {
        await waitForDiskReleased(bundleDiskPath(await resolveLumeName(body.from_well)), 60_000);
      } catch (e) {
        return apiError(500, "disk_released_timeout", (e as Error).message);
      }
    } else {
      log.info("save: probe passed, stopping for clonefile", {
        well: body.from_well,
      });
      try {
        await transitionWell(body.from_well, "stop", defaultActuators);
      } catch (e) {
        return apiError(500, "stop_failed", (e as Error).message);
      }
    }
  } else if (info && info.status === "running") {
    return apiError(
      409,
      "well_running",
      `well '${body.from_well}' is running — stop it first or pass validate=true to have welld stop+probe+save atomically`,
    );
  }

  try {
    const meta = await saveImage({
      fromWell: body.from_well,
      imageName: body.name,
      rinsed: didRinse,
      ...(body.notes ? { notes: body.notes } : {}),
    });
    if (!Value.Check(ImageResource, meta)) {
      log.error("response shape failed validation", {
        route: "POST /v1/wells/images",
      });
      return new Response("internal: response shape mismatch\n", { status: 500 });
    }
    return Response.json(meta, { status: 201 });
  } catch (e) {
    return apiError(400, "save_failed", (e as Error).message);
  }
}

async function handleDeleteImage(name: string): Promise<Response> {
  let removed: boolean;
  try {
    removed = await removeImage(name);
  } catch (e) {
    return apiError(400, "delete_failed", (e as Error).message);
  }
  return Response.json({ name, removed });
}

// W.4 — image library push. Body may carry an R2LibraryConfig; if
// absent, fall back to WELL_R2_LIBRARY_* env. Either way, all four
// fields must resolve or we 400.
async function handlePushImage(name: string, req: Request): Promise<Response> {
  const cfg = await resolveR2LibraryConfig(req);
  if ("error" in cfg) return cfg.error;
  try {
    const result = await pushImage(name, cfg.config, VERSION);
    return Response.json(result, { status: 201 });
  } catch (e) {
    const msg = (e as Error).message;
    const status = /not found locally|malformed/i.test(msg) ? 404 : 500;
    return apiError(status, "push_failed", msg);
  }
}

// W.5 — image library pull. Same config story as push.
async function handlePullImage(name: string, req: Request): Promise<Response> {
  const cfg = await resolveR2LibraryConfig(req);
  if ("error" in cfg) return cfg.error;
  try {
    const result = await pullImage(name, cfg.config);
    return Response.json(result, { status: 201 });
  } catch (e) {
    const msg = (e as Error).message;
    const status = /manifest\.json not in R2/i.test(msg) ? 404 : 500;
    return apiError(status, "pull_failed", msg);
  }
}

// Shared config resolver for push/pull. Returns either {config} or
// {error: Response}.
async function resolveR2LibraryConfig(
  req: Request,
): Promise<{ config: R2LibraryConfig } | { error: Response }> {
  let bodyConfig: Partial<R2LibraryConfig> = {};
  if (
    req.headers.get("content-length") &&
    req.headers.get("content-length") !== "0"
  ) {
    try {
      const body = await req.json();
      if (body && typeof body === "object") {
        bodyConfig = body as Partial<R2LibraryConfig>;
      }
    } catch {
      return {
        error: apiError(400, "bad_request", "request body must be JSON or empty"),
      };
    }
  }
  const config: R2LibraryConfig = {
    endpoint: bodyConfig.endpoint ?? process.env.WELL_R2_LIBRARY_ENDPOINT ?? "",
    bucket: bodyConfig.bucket ?? process.env.WELL_R2_LIBRARY_BUCKET ?? "",
    access_key_id:
      bodyConfig.access_key_id ?? process.env.WELL_R2_LIBRARY_ACCESS_KEY_ID ?? "",
    secret_access_key:
      bodyConfig.secret_access_key ??
      process.env.WELL_R2_LIBRARY_SECRET_ACCESS_KEY ??
      "",
  };
  const missing = (Object.keys(config) as (keyof R2LibraryConfig)[]).filter(
    (k) => !config[k],
  );
  if (missing.length > 0) {
    return {
      error: apiError(
        400,
        "r2_config_missing",
        `R2 library config missing fields: ${missing.join(", ")} — pass in body or set WELL_R2_LIBRARY_* env`,
      ),
    };
  }
  return { config };
}

async function handleCreateCheckpoint(name: string, req: Request): Promise<Response> {
  const record = await findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);
  // Checkpoint create syncs the guest filesystem before clonefile, so it
  // requires the well to be running. Wake-on-demand if stopped.
  try {
    await ensureRunning(name, 10_000);
  } catch (err) {
    return apiError(504, "wake_failed", (err as Error).message);
  }
  // Body is optional. Empty body is fine (most callers don't send one).
  let comment: string | undefined;
  let retainForSeconds: number | undefined;
  if (req.headers.get("content-length") && req.headers.get("content-length") !== "0") {
    try {
      const body = await req.json() as { comment?: unknown; retain_for?: unknown };
      if (typeof body?.comment === "string") comment = body.comment;
      if (typeof body?.retain_for === "string") {
        const parsed = parseDuration(body.retain_for);
        if (parsed === undefined) {
          return apiError(
            400,
            "bad_request",
            `invalid retain_for: '${body.retain_for}' (expected e.g. 7d, 12h, 30m, 45s)`,
          );
        }
        retainForSeconds = parsed;
      }
    } catch {
      // Treat unparseable body as no comment — sprites is lenient here.
    }
  }
  let cp;
  try {
    cp = await createCheckpoint(name, {
      ...(comment !== undefined ? { comment } : {}),
      ...(retainForSeconds !== undefined ? { retainForSeconds } : {}),
    });
  } catch (e) {
    return apiError(500, "checkpoint_failed", (e as Error).message);
  }
  // Re-list to pick up physical_bytes (computed at list time from st_blocks).
  const all = await listCheckpoints(name);
  const fresh = all.find((c) => c.id === cp.id);
  if (!fresh) return apiError(500, "checkpoint_vanished", `checkpoint '${cp.id}' missing post-create`);
  if (!Value.Check(CheckpointResource, fresh)) {
    log.error("response shape failed validation", {
      route: `POST /v1/wells/${name}/checkpoints`,
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(fresh, { status: 201 });
}

async function handleListCheckpoints(name: string): Promise<Response> {
  const record = await findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);
  const checkpoints = await listCheckpoints(name);
  const body = { checkpoints };
  if (!Value.Check(CheckpointsListResponse, body)) {
    log.error("response shape failed validation", {
      route: `GET /v1/wells/${name}/checkpoints`,
      errors: [...Value.Errors(CheckpointsListResponse, body)].slice(0, 3),
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}

async function handleExpireCheckpoint(name: string, id: string): Promise<Response> {
  const record = await findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);
  const r = await expireCheckpoint(name, id);
  return Response.json({ id, removed: r.removed });
}

async function handleRestoreCheckpoint(
  name: string,
  id: string,
  fromR2: boolean,
): Promise<Response> {
  const record = await findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);
  try {
    await restoreCheckpoint(name, id, { fromR2 });
  } catch (e) {
    const msg = (e as Error).message;
    const status = /not found/i.test(msg) ? 404 : 500;
    return apiError(status, "restore_failed", msg);
  }
  const body = await buildWellResource(name);
  if (!body) return apiError(500, "vanished", `well '${name}' missing post-restore`);
  return wellResourceResponse(body, `POST /v1/wells/${name}/checkpoints/${id}/restore`);
}

async function handleNetworkPolicy(name: string, req: Request): Promise<Response> {
  const record = await findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(NetworkPolicyRequest, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(NetworkPolicyRequest, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const body = parsed as NetworkPolicyRequest;

  // Persist atomically: write tmp, rename. The vmDir always exists for
  // a registered well so we don't need to mkdir. Phase A still owes
  // the actual pf-rule enforcement; persistence is independent of that.
  const path = PATHS.vmPolicy(name);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await Bun.write(tmp, JSON.stringify({ rules: body.rules }, null, 2));
  await rename(tmp, path);

  const response: NetworkPolicyResponse = {
    accepted: true,
    enforced: false,
    rules: body.rules,
  };
  if (!Value.Check(NetworkPolicyResponse, response)) {
    log.error("response shape failed validation", {
      route: `POST /v1/wells/${name}/policy/network`,
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(response);
}

async function handlePatchWell(name: string, req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(PatchWellRequest, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(PatchWellRequest, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const body = parsed as PatchWellRequest;

  // Sparse update: only fields actually present in the body get touched.
  if ("auto_sleep_seconds" in body) {
    const updated = await updateWellAutoSleep(name, body.auto_sleep_seconds!);
    if (!updated) return apiError(404, "not_found", `well '${name}' not found`);
  } else {
    // No-op PATCH (no recognized fields) — still 404 if well missing,
    // for symmetry with the success path.
    const exists = await findWell(name);
    if (!exists) return apiError(404, "not_found", `well '${name}' not found`);
  }

  const resource = await buildWellResource(name);
  if (!resource) return apiError(500, "vanished", `well '${name}' missing post-patch`);
  return wellResourceResponse(resource, `PATCH /v1/wells/${name}`);
}

async function handleUpdateUrl(name: string, req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(UrlUpdateRequest, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(UrlUpdateRequest, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const body = parsed as UrlUpdateRequest;
  const updated = await updateWellAuth(name, body.auth);
  if (!updated) return apiError(404, "not_found", `well '${name}' not found`);

  const resource = await buildWellResource(name);
  if (!resource) return apiError(500, "vanished", `well '${name}' missing post-update`);
  return wellResourceResponse(resource, `PUT /v1/wells/${name}/url`);
}

// GET counterpart — cells reads `policy.rules[*].{action, domain}`, tolerates
// 404/empty (`.catch(() => null)` on the cells side). We always 200 the
// success path; on ENOENT or invalid-shape we return `{rules: []}`.
async function handleGetNetworkPolicy(name: string): Promise<Response> {
  const record = await findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);
  let body: { rules: NetworkPolicyRequest["rules"] } = { rules: [] };
  try {
    const raw = await Bun.file(PATHS.vmPolicy(name)).text();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.rules)) body = { rules: parsed.rules };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("policy read failed, returning empty", { name, err: (e as Error).message });
    }
  }
  return Response.json(body);
}

async function handleDestroyWell(name: string): Promise<Response> {
  let r;
  try {
    r = await destroyWell(name);
  } catch (e) {
    return apiError(500, "destroy_failed", (e as Error).message);
  }
  // Clear in-memory idle state so a future well with the same name
  // doesn't inherit a stale lastTouched. Without this, recreating a
  // well that was previously touched > auto_sleep_seconds ago gets
  // immediately hibernated by the next watchdog tick (cells team hit
  // this 2026-05-10 with ck-pi-gpt55: prior instance touched at 21:14
  // then destroyed without clear; new instance created at 21:20:52
  // got hibernated 6s later because the watchdog saw a 7-min-old
  // touch as "idle past the 60s threshold").
  clearLastTouched(name);
  watchdogHibFailures.delete(name);
  const body = {
    name,
    found: r.found,
    removed_registry: r.removedRegistry,
    removed_state_dir: r.removedStateDir,
    removed_bundle: r.removedBundle,
  };
  if (!Value.Check(DestroyResponse, body)) {
    log.error("response shape failed validation", { route: `DELETE /v1/wells/${name}` });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}

// Synchronous HTTP exec — buffer stdout/stderr to a hard cap and return
// JSON. Mirrors the shell-escape handling from the WS handler so scripts
// with metacharacters round-trip correctly. The cap exists to prevent a
// runaway guest from filling the daemon's heap; on overflow we kill the
// ssh proc and emit `truncated: true`.
const EXEC_OUTPUT_CAP_BYTES = 4 * 1024 * 1024;

async function handleHttpExec(name: string, req: Request): Promise<Response> {
  const record = await findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);

  try {
    await ensureRunning(name, 10_000);
  } catch (err) {
    return apiError(504, "wake_failed", (err as Error).message);
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(ExecRequest, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(ExecRequest, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const body = parsed as ExecRequest;
  if (body.command.length === 0) {
    return apiError(400, "bad_request", "command must not be empty");
  }

  const ip = await resolveWellIp(name);
  if (!ip) {
    return apiError(409, "no_lease", `well '${name}' has no DHCP lease — start it first`);
  }

  const user = body.user ?? "well";
  // SSH always lands as `well` (the only user firstboot sets up with
  // host pubkey beyond `ubuntu`), and we sudo-switch to `user` if the
  // caller wants a different identity. This means cells team's `cell`
  // user (created during their bake, no SSH setup) is reachable via
  // `well exec --user=cell` without the client-side sudo wrap they
  // were using before.
  await ensureSshMaster({ name, ip, user: "well", keyPath: PATHS.vmSshKey(name) });
  const innerCmd = body.command.map(shellEscape).join(" ");
  const remoteCmd =
    user === "well"
      ? innerCmd
      : `sudo -n -u ${shellEscape(user)} bash -c ${shellEscape(innerCmd)}`;
  const proc = spawn(
    [
      "ssh",
      ...sshControlArgs(name),
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-i", PATHS.vmSshKey(name),
      `well@${ip}`,
      remoteCmd,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );

  let truncated = false;
  let total = 0;
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (truncated) continue;
        if (total + value.length > EXEC_OUTPUT_CAP_BYTES) {
          truncated = true;
          try { proc.kill(); } catch {}
          continue;
        }
        chunks.push(value);
        total += value.length;
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    return Buffer.concat(chunks).toString("utf-8");
  };

  const [stdout, stderr, exit] = await Promise.all([
    drain(proc.stdout),
    drain(proc.stderr),
    proc.exited,
  ]);

  const response: ExecResponse = {
    exit_code: exit,
    stdout,
    stderr,
    ...(truncated ? { truncated: true } : {}),
  };
  return Response.json(response);
}

async function handlePutService(well: string, id: string, req: Request): Promise<Response> {
  const record = await findWell(well);
  if (!record) return apiError(404, "not_found", `well '${well}' not found`);
  // Service apply needs ssh into the guest, so wake-on-demand.
  try {
    await ensureRunning(well, 10_000);
  } catch (err) {
    return apiError(504, "wake_failed", (err as Error).message);
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(ServiceDefinition, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(ServiceDefinition, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const def = parsed as ServiceDefinition;

  let resource;
  try {
    resource = await putService(well, id, def);
  } catch (e) {
    const msg = (e as Error).message;
    const status = /invalid/i.test(msg) ? 400 : 500;
    return apiError(status, "service_apply_failed", msg);
  }
  if (!Value.Check(ServiceResource, resource)) {
    log.error("response shape failed validation", {
      route: `PUT /v1/wells/${well}/services/${id}`,
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(resource);
}

async function ensureRunningOrWakeFailed(name: string): Promise<Response | null> {
  try {
    await ensureRunning(name, 10_000);
    return null;
  } catch (err) {
    return apiError(504, "wake_failed", (err as Error).message);
  }
}

async function handleDeleteService(well: string, id: string): Promise<Response> {
  const record = await findWell(well);
  if (!record) return apiError(404, "not_found", `well '${well}' not found`);
  // Delete ssh's into the guest to disable the systemd unit; wake first.
  const wakeErr = await ensureRunningOrWakeFailed(well);
  if (wakeErr) return wakeErr;
  let found: boolean;
  try {
    found = await deleteService(well, id);
  } catch (e) {
    return apiError(500, "service_delete_failed", (e as Error).message);
  }
  return Response.json({ id, well, found });
}

async function handleGetService(well: string, id: string): Promise<Response> {
  const record = await findWell(well);
  if (!record) return apiError(404, "not_found", `well '${well}' not found`);
  let resource;
  try {
    resource = await getService(well, id);
  } catch (e) {
    return apiError(400, "bad_request", (e as Error).message);
  }
  if (!resource) return apiError(404, "not_found", `service '${id}' not found on well '${well}'`);
  if (!Value.Check(ServiceResource, resource)) {
    log.error("response shape failed validation", {
      route: `GET /v1/wells/${well}/services/${id}`,
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(resource);
}

async function handleListServices(well: string): Promise<Response> {
  const record = await findWell(well);
  if (!record) return apiError(404, "not_found", `well '${well}' not found`);
  const services = await listServices(well);
  const body = { services };
  if (!Value.Check(ServicesListResponse, body)) {
    log.error("response shape failed validation", {
      route: `GET /v1/wells/${well}/services`,
      errors: [...Value.Errors(ServicesListResponse, body)].slice(0, 3),
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}

// Cell metadata server. A second Bun.serve bound to the vmnet bridge
// IP, reachable from inside cells as `host.well`. Exposes a tiny
// cooperation API: cells signal /working / /idle / /sleep-now to drive
// their own pause behavior. Network is the trust boundary — only
// traffic from a vmnet-leased IP is honored, so no Bearer auth needed.
//
// The bind discovery: walk OS network interfaces, pick the first one
// whose name starts with "bridge" and has an IPv4 address. If absent
// (no VMs ever started → no bridge), skip starting the metadata server;
// the rest of welld still works.

function findBridgeIp(): string | null {
  const ifaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!name.startsWith("bridge") || !addrs) continue;
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

const METADATA_PORT = 7879;
const BRIDGE_DNS_PORT = 5353;
const bridgeIp = findBridgeIp();

// W.20 — per-well consecutive hibernate-failure counter. Resets on
// success. Once a well crosses the threshold, the watchdog stops
// trying to hibernate it until something else clears the entry
// (lume restart on welld restart; well destroy clears the row but
// not the map — that's a tiny leak we accept).
const watchdogHibFailures = new Map<string, number>();
const WATCHDOG_HIB_FAIL_THRESHOLD = 5;
let metadataServer: ReturnType<typeof Bun.serve> | null = null;
if (bridgeIp) {
  metadataServer = Bun.serve({
    port: METADATA_PORT,
    hostname: bridgeIp,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      const ip = srv.requestIP(req)?.address ?? null;
      if (!ip) return new Response("no source IP\n", { status: 400 });
      const name = await findWellByIp(ip);
      if (!name) {
        return new Response(
          `unknown source ${ip}\n`,
          { status: 403 },
        );
      }

      if (req.method !== "POST") {
        return new Response("only POST\n", { status: 405 });
      }

      // Two endpoints, both authless (caller identified by source IP):
      //   POST /lifecycle  body {state:"busy"|"idle"}  hint to the
      //     watchdog. busy → don't hibernate; idle → eligible.
      //   POST /sleep      no body                     explicit
      //     "release my RAM now". Hibernates the well.
      if (url.pathname === "/lifecycle") {
        const text = await req.text();
        const parsed = parseLifecycleBody(text);
        if (!parsed.ok) {
          return new Response(`${parsed.error}\n`, { status: 400 });
        }
        const result = applyLifecycleState(name, parsed.state!);
        log.info("cell lifecycle signal", { name, state: parsed.state });
        return Response.json({ ok: true, name, state: parsed.state, busy: result.busy });
      }

      if (url.pathname === "/sleep") {
        markIdle(name);
        // Defer the actual hibernation so the response can flush
        // before the VM's RAM is dumped — the response goes through
        // the same vmnet bridge that's about to halt.
        queueMicrotask(async () => {
          try {
            await transitionWell(name, "hibernate", defaultActuators);
            log.info("cell self-hibernated", { name });
          } catch (e) {
            log.error("cell sleep failed", {
              name,
              err: (e as Error).message,
            });
          }
        });
        return Response.json({ ok: true, name, state: "hibernating" });
      }

      return new Response("not found\n", { status: 404 });
    },
  });
  log.info("cell metadata server up", {
    url: `http://${metadataServer.hostname}:${metadataServer.port}`,
  });
  // Bridge DNS — sibling to the metadata server. Fire-and-forget;
  // start failures are logged inside startBridgeDns and don't block
  // welld startup (DNS is comfort, not load-bearing).
  startBridgeDns({ hostname: bridgeIp, port: BRIDGE_DNS_PORT }).catch(
    (e) =>
      log.error("bridge DNS start threw", { err: (e as Error).message }),
  );
} else {
  log.info("no vmnet bridge found; cell metadata server skipped");
}

// Watchdog: scan every 30s, stop any well past its idle threshold.
// Per-well override on the record beats the global default; null = never.
const WATCHDOG_INTERVAL_MS = 30_000;

async function watchdogTick(): Promise<void> {
  const defaults = await loadDefaults();
  const records = await listWells();
  const lume = new LumeClient();
  const lumeList = await lume.list().catch(() => [] as VMSummary[]);
  // "Really running" = lume reports running AND ipAddress is set. Lume's
  // status field is sticky after VZ-side errors (cells team flap report
  // 2026-05-09 21:07 UTC + dev repro 21:22 UTC): SIGKILL'd
  // VirtualMachine.xpc → lume keeps status="running" while ipAddress
  // drops to null. Treating those as running fed save-state on broken
  // VMs and crashed lume serve. The watchdog can afford the conservative
  // shape (a fresh-boot well with ipAddress=null briefly will be picked
  // up on the next tick once lume's lease watcher catches up — 13s typ).
  // The hibernate pre-flight in lib/lifecycle.ts uses the same first
  // pass but has a substrate-truth fallback for the fresh-boot case.
  const runningLumeNames = new Set(
    lumeList
      .filter((v) => v.status === "running" && v.ipAddress != null)
      .map((v) => v.name),
  );
  // Adopted wells (A.1.4.c.iv) have lume_name=pool-XXXX while
  // record.name is the operator-chosen name; the lume.list output
  // is keyed by the lume bundle name, so the watchdog must resolve
  // through lumeNameOf to find the right entry. Pre-A.1.4 wells
  // and fresh-create wells have lume_name === name and fall
  // through unchanged.
  const recordsByName = new Map(records.map((r) => [r.name, r]));

  const slept = await runWatchdogTick({
    records,
    isRunning: (n) => {
      const rec = recordsByName.get(n);
      const lumeKey = rec ? lumeNameOf(rec) : n;
      return runningLumeNames.has(lumeKey);
    },
    lastTouchedMs: getLastTouched,
    nowMs: Date.now(),
    defaultSeconds: defaults.auto_sleep_seconds,
    stopWell: async (n) => {
      // Idle expiry = hibernate. Pete's contract (B.0.7): "Normal
      // cells sleep should mean 'hibernate this agent,' not 'stop
      // the VM.'" Hibernation releases RAM (the substrate guarantee
      // cells team relies on); pause kept RAM resident.
      //
      // W.20 backoff — a well stuck in `error` state at the lume
      // layer rejects every save-state with a 400 every tick (30s).
      // After WATCHDOG_HIB_FAIL_THRESHOLD consecutive failures, drop
      // out — the well is dead-stuck until something external (lume
      // restart, well destroy) clears it. Counter resets on success.
      if ((watchdogHibFailures.get(n) ?? 0) >= WATCHDOG_HIB_FAIL_THRESHOLD) {
        return;
      }
      log.info("watchdog: hibernating idle well", { name: n });
      try {
        await transitionWell(n, "hibernate", defaultActuators);
        watchdogHibFailures.delete(n);
      } catch (err) {
        const cur = (watchdogHibFailures.get(n) ?? 0) + 1;
        watchdogHibFailures.set(n, cur);
        if (cur === WATCHDOG_HIB_FAIL_THRESHOLD) {
          log.warn("watchdog: well stuck, suspending hibernate attempts", {
            name: n,
            failures: cur,
          });
        } else {
          log.error("watchdog: hibernate failed", {
            name: n,
            err: (err as Error).message,
            failures: cur,
          });
        }
      }
    },
    probeActivity: async (n) => {
      // Cooperative agent signal trumps every other heuristic. Set
      // via /v1/cells/me/working from inside the cell.
      if (isBusy(n)) return true;
      const ip = await resolveWellIp(n);
      if (!ip) return false;
      const sample = await sampleActivity(ip);
      return sample.isActive;
    },
  });
  if (slept.length > 0) {
    log.info("watchdog: tick hibernated wells", { hibernated: slept });
  }

  // Reap dangling `lume run` subprocesses. Lume serve crashes during
  // destroy can orphan the welld-spawned run subprocess; sweep them
  // by name vs the registry. Failures here aren't fatal — log and
  // move on.
  await sweepDanglingLumeRun().catch((err) =>
    log.warn("watchdog: lume-run gc failed", { err: (err as Error).message }),
  );
}

const watchdogTimer = setInterval(() => {
  watchdogTick().catch((err) =>
    log.error("watchdog: tick failed", { err: (err as Error).message }),
  );
}, WATCHDOG_INTERVAL_MS);
// Don't keep the event loop alive just for the watchdog — welld's
// HTTP server is what holds the process up.
(watchdogTimer as unknown as { unref?: () => void }).unref?.();

// W.23 (cells-team) — drop any zombie pool entries left by a prior
// crash before the filler starts adopting from them. A zombie is a
// registry entry whose lume bundle dir doesn't exist on disk; the
// adopt path 400's "create_failed: lume config missing" if one
// slips through. Cheap startup pass: stat each member's bundle.
const pruned = await prunePoolZombies();
if (pruned.length > 0) {
  log.info("welld: pruned zombie pool members at startup", { count: pruned.length, names: pruned });
}

// A.1.4.b.ii — start the background pool filler. No-op when
// defaults.pool_size is 0 (the default); cells team raises it via
// defaults.json to opt in.
const stopPoolFiller = startPoolFiller();

log.info("welld listening", {
  url: `http://${server.hostname}:${server.port}`,
  token_path: "~/.wells/token",
});

const shutdown = () => {
  log.info("welld shutting down");
  clearInterval(watchdogTimer);
  stopPoolFiller();
  server.stop();
  stopLumeServe(lumeHandle);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
