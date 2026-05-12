#!/usr/bin/env bun
// welld — the wells daemon. HTTP on :7878. Sprites-shaped REST.
// Phase 0+1: /healthz, supervises lume serve. Phase 8 lands the rest.

import { spawn, type Subprocess } from "bun";
import { rename } from "node:fs/promises";
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
import { isAuthorized } from "../lib/auth.ts";
import { apiError, unauthorized } from "../lib/apiResponse.ts";
import { countVzXpcProcesses } from "../lib/vzXpcCount.ts";
import { findWell, listWells, lumeNameOf, resolveLumeName } from "../lib/registry.ts";
import {
  computeOrphanLeases,
  dumpDhcpLeases,
  findWellByIp,
  resolveWellIp,
} from "../lib/dhcp.ts";
import { releaseLease, releaseLeaseBestEffort } from "../lib/dhcpHelper.ts";
import { isBusy, markIdle } from "../lib/cellState.ts";
import { applyLifecycleState, parseLifecycleBody } from "../lib/cellLifecycle.ts";
import { probeImageSource } from "../lib/imageValidation.ts";
import { rinseGuest } from "../lib/rinseWell.ts";
import { waitForDiskReleased } from "../lib/diskReleased.ts";
import { bundleDiskPath } from "../engine/bundle.ts";
import { networkInterfaces } from "node:os";
import { findBridgeIpFromInterfaces } from "../lib/bridgeIp.ts";
import { PATHS } from "../lib/state.ts";
import { createWell, diskUsageBytes } from "../lib/createWell.ts";
import { destroyWell } from "../lib/destroy.ts";
import { drainAllPoolMembers, drainReadyPoolMembers, prunePoolZombies, startPoolFiller, triggerFillIfNeeded } from "../lib/poolFiller.ts";
import { listPoolMembers, poolSummary } from "../lib/poolRegistry.ts";
import { loadDefaults } from "../lib/defaults.ts";
import { defaultActuators, transitionWell } from "../lib/wellLifecycle.ts";
import {
  handleLifecycle as handleLifecycleHandler,
  type LifecycleDeps,
} from "../lib/handlers/lifecycle.ts";
import {
  handleHibernation as handleHibernationHandler,
  type HibernationDeps,
} from "../lib/handlers/hibernation.ts";
import {
  handleGetWell as handleGetWellHandler,
  type GetWellDeps,
} from "../lib/handlers/getWell.ts";
import {
  handleCreateWell as handleCreateWellHandler,
  type CreateWellDeps,
} from "../lib/handlers/createWell.ts";
import {
  handleListWells as handleListWellsHandler,
  type ListWellsDeps,
} from "../lib/handlers/listWells.ts";
import {
  handleDestroyWell as handleDestroyWellHandler,
  type DestroyWellDeps,
} from "../lib/handlers/destroyWell.ts";
import {
  handleListPool as handleListPoolHandler,
  handleRefillPool as handleRefillPoolHandler,
  handleDrainPool as handleDrainPoolHandler,
  type ListPoolDeps,
  type RefillPoolDeps,
  type DrainPoolDeps,
} from "../lib/handlers/pool.ts";
import {
  handleReleaseLease as handleReleaseLeaseHandler,
  handleFlushLeases as handleFlushLeasesHandler,
  type ReleaseLeaseDeps,
  type FlushLeasesDeps,
} from "../lib/handlers/lease.ts";
import {
  handleListImages as handleListImagesHandler,
  handleGetImage as handleGetImageHandler,
  handleSaveImage as handleSaveImageHandler,
  handleDeleteImage as handleDeleteImageHandler,
  handlePushImage as handlePushImageHandler,
  handlePullImage as handlePullImageHandler,
  resolveR2LibraryConfig as resolveR2LibraryConfigHandler,
  type ListImagesDeps,
  type GetImageDeps,
  type SaveImageDeps,
  type DeleteImageDeps,
  type PushImageDeps,
  type PullImageDeps,
} from "../lib/handlers/image.ts";
import {
  handleCreateCheckpoint as handleCreateCheckpointHandler,
  handleListCheckpoints as handleListCheckpointsHandler,
  handleExpireCheckpoint as handleExpireCheckpointHandler,
  handleRestoreCheckpoint as handleRestoreCheckpointHandler,
  type CreateCheckpointDeps,
  type ListCheckpointsDeps,
  type ExpireCheckpointDeps,
  type RestoreCheckpointDeps,
} from "../lib/handlers/checkpoint.ts";
import {
  handleNetworkPolicy as handleNetworkPolicyHandler,
  handleGetNetworkPolicy as handleGetNetworkPolicyHandler,
  handlePatchWell as handlePatchWellHandler,
  handleUpdateUrl as handleUpdateUrlHandler,
  type SetNetworkPolicyDeps,
  type GetNetworkPolicyDeps,
  type PatchWellDeps,
  type UpdateUrlDeps,
} from "../lib/handlers/wellMeta.ts";
import {
  handlePutService as handlePutServiceHandler,
  handleDeleteService as handleDeleteServiceHandler,
  handleGetService as handleGetServiceHandler,
  handleListServices as handleListServicesHandler,
  type PutServiceDeps,
  type DeleteServiceDeps,
  type GetServiceDeps,
  type ListServicesDeps,
} from "../lib/handlers/service.ts";
import {
  handleHttpExec as handleHttpExecHandler,
  type HttpExecDeps,
} from "../lib/handlers/httpExec.ts";
import {
  buildWellResource as buildWellResourceImpl,
  type BuildWellResourceDeps,
} from "../lib/buildWellResource.ts";
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
  imageMeta,
  listImages,
  removeImage,
  saveImage,
} from "../lib/imageStore.ts";
import { pullImage, pushImage } from "../lib/imageLibrary.ts";
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
import { buildDashboardData, renderDashboardHtml } from "../lib/dashboard.ts";
import { checkBootpdOverlap, loadStaticRange } from "../lib/ipPool.ts";

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

// Cells team 2026-05-11 06:58Z: welld restart drops all running VMs to
// status=stopped (lume's supervisor cycle clips XPC children). Cells's
// Tier 4 birth wedge bets on running-resident eggs — losing them on
// every restart is a big-enough wedge to warrant resurrection.
// Policy: runtime.json wins on startup. Wells whose prior state was
// alive_running OR alive_paused get cold-started; hibernating + stopped
// + error_orphaned stay untouched. See lib/resurrect.ts for the full
// skip matrix.
const { resurrectAliveWells } = await import("../lib/resurrect.ts");
resurrectAliveWells()
  .then((r) => {
    if (r.resurrected.length > 0 || r.failed.length > 0) {
      log.info("startup: resurrection pass complete", {
        considered: r.considered,
        resurrected: r.resurrected,
        failed_count: r.failed.length,
        skipped_count: r.skipped.length,
      });
    }
    for (const f of r.failed) {
      log.warn("startup: resurrect failed", { name: f.name, err: f.error });
    }
  })
  .catch((err) =>
    log.warn("startup: resurrection threw", { err: (err as Error).message }),
  );

// W.72 startup gate. When the operator has opted into static IP
// allocation, refuse to start if our range overlaps macOS bootpd's
// declared DHCP grant range — overlap would let bootpd hand out an
// address we think we own, racing with welld's allocator. Absent
// bootpd.plist (Apple's default vmnet) is fine: log an advisory and
// trust the configured range to sit clear of bootpd's defaults.
{
  const staticRange = await loadStaticRange().catch((e: unknown) => {
    log.error("W.72: failed to load static_ip_range — refusing to start", {
      err: (e as Error).message,
    });
    process.exit(1);
  });
  if (staticRange) {
    const r = await checkBootpdOverlap(staticRange);
    if (r.overlap) {
      log.error("W.72: bootpd / static-range overlap — refusing to start", {
        reason: r.reason,
        hint: "narrow defaults.static_ip_range to a span above bootpd's grant pool, or unset it (null) to fall back to DHCP",
      });
      process.exit(1);
    }
    log.info("W.72: static IP allocation enabled", {
      range: `192.168.64.${staticRange.start}-${staticRange.end}`,
      bootpd_check: r.reason,
    });
  }
}

// Pure implementation extracted to lib/auth.ts. Local closure binds TOKEN.
function authorized(req: Request, urlForQuery?: URL): boolean {
  return isAuthorized(req, TOKEN, urlForQuery);
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
      // step. Surface total + orphans so operators can see the bloat
      // without sudo'ing into /var/db/dhcpd_leases by hand.
      // `computeOrphanLeases` partitions against welld's known names
      // (registry wells, adopted-well lume names, warming pool
      // members) so pool-XXXX entries aren't false-flagged as orphans.
      const [vmnetLeases, vmnetOrphans] = await Promise.all([
        dumpDhcpLeases(),
        computeOrphanLeases(),
      ]);
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

    // Operator dashboard — public on localhost (welld binds to 127.0.0.1
    // only, so the page is local-only by construction). /dashboard serves
    // the self-contained HTML; /dashboard/data serves the JSON the page
    // polls every 4s. Both bypass the bearer token gate so an operator
    // can just open the URL in a browser without juggling Authorization
    // headers.
    if (req.method === "GET" && url.pathname === "/dashboard") {
      return new Response(renderDashboardHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (req.method === "GET" && url.pathname === "/dashboard/data") {
      const data = await buildDashboardData({
        version: VERSION,
        started_at: startedAt,
        lume_base_url: lumeHandle.baseUrl,
        lume_owned: lumeHandle.spawned !== null,
      });
      return Response.json(data);
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

    // vmnet DHCP lease operations (cells team 2026-05-11). welld auto-
    // releases on destroy; these endpoints let cells team explicitly
    // release a single lease or flush the whole table without
    // shell-access. Both shell out to the privileged helper at
    // /usr/local/sbin/welld-dhcp-helper (installed via
    // scripts/install-dhcp-helper.sh). Helper-not-installed surfaces
    // as 503 so callers can detect + suggest install.
    if (url.pathname === "/v1/lume/leases/flush" && req.method === "POST") {
      return handleFlushLeases();
    }
    const lease = /^\/v1\/lume\/leases\/([^/]+)$/.exec(url.pathname);
    if (lease && req.method === "DELETE") {
      const hostname = decodeURIComponent(lease[1]!);
      return handleReleaseLease(hostname);
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


// Pure orchestration extracted to lib/handlers/listWells.ts. Wires the
// real registry + lume + IP-resolver + config-base deps.
const listWellsDeps: ListWellsDeps = {
  listWells,
  listLumeVms: async () => {
    const lume = new LumeClient();
    return lume.list().catch(() => [] as VMSummary[]);
  },
  publicBase,
  resolveWellIp,
};
async function handleListWells(): Promise<Response> {
  return handleListWellsHandler(listWellsDeps);
}

// Pure implementation extracted to lib/buildWellResource.ts — used by six
// handlers (getWell, lifecycle, hibernation, patch, url, restoreCheckpoint).
const buildWellResourceDeps: BuildWellResourceDeps = {
  findWell,
  lumeNameOf,
  lumeInfo: async (n) => {
    const lume = new LumeClient();
    return lume.info(n).catch(() => null);
  },
  resolveWellIp,
  diskUsageBytes,
  publicBase,
};
async function buildWellResource(name: string) {
  return buildWellResourceImpl(name, buildWellResourceDeps);
}

// Response builders moved to lib/apiResponse.ts; handler logic in lib/handlers/.

// Pure orchestration extracted to lib/handlers/getWell.ts.
const getWellDeps: GetWellDeps = { buildWellResource };
async function handleGetWell(name: string): Promise<Response> {
  return handleGetWellHandler(name, getWellDeps);
}

// Pure orchestration extracted to lib/handlers/lifecycle.ts so the
// branching is unit-testable. The daemon wires the real deps below.
// Logic note: start routes through ensureRunning so paused/hibernating
// wells transparently wake (cells team's wake-on-traffic contract,
// B.0.7); stop routes through transitionWell so the state machine
// handles lock + dispatch + actuate + write runtime.
const lifecycleDeps: LifecycleDeps = {
  findWell,
  ensureRunning,
  transitionWell: (name, verb) => transitionWell(name, verb, defaultActuators),
  buildWellResource,
};
async function handleLifecycle(
  name: string,
  verb: "start" | "stop",
): Promise<Response> {
  return handleLifecycleHandler(name, verb, lifecycleDeps);
}

// Pure orchestration extracted to lib/handlers/hibernation.ts.
// State-machine note: both verbs go through transitionWell (B.0.7.g).
// hibernate-on-hibernating and wake-on-running are documented no-op
// successes; failed restore writes error_orphaned in wakeWell on
// recipe drift, rather than ambiguous stopped.
const hibernationDeps: HibernationDeps = {
  findWell,
  transitionWell: (name, verb) => transitionWell(name, verb, defaultActuators),
  buildWellResource,
};
async function handleHibernation(
  name: string,
  verb: "hibernate" | "wake",
): Promise<Response> {
  return handleHibernationHandler(name, verb, hibernationDeps);
}

// Pure orchestration extracted to lib/handlers/createWell.ts. Two write
// paths (createWell vs thawFrom) and failure-path lease release are all
// dep-injected so the branching is unit-testable. thawFrom is bound to
// the lib/thaw.ts module here (lazy import preserved so non-thaw create
// doesn't pay the import cost).
const createWellDeps: CreateWellDeps = {
  createWell,
  thawFrom: async (opts) => {
    const { thawFrom } = await import("../lib/thaw.ts");
    return thawFrom(opts);
  },
  clearLastTouched,
  releaseLeaseBestEffort,
  buildWellResource,
};
async function handleCreateWell(req: Request): Promise<Response> {
  return handleCreateWellHandler(req, createWellDeps);
}

// Pure orchestration extracted to lib/handlers/image.ts.
const listImagesDeps: ListImagesDeps = { listImages };
async function handleListImages(): Promise<Response> {
  return handleListImagesHandler(listImagesDeps);
}

// Pure orchestration extracted to lib/handlers/pool.ts.
const listPoolDeps: ListPoolDeps = { listPoolMembers, loadDefaults };
const refillPoolDeps: RefillPoolDeps = { triggerFillIfNeeded };
const drainPoolDeps: DrainPoolDeps = { drainAllPoolMembers, drainReadyPoolMembers };
async function handleListPool(): Promise<Response> {
  return handleListPoolHandler(listPoolDeps);
}
async function handleRefillPool(): Promise<Response> {
  return handleRefillPoolHandler(refillPoolDeps);
}
async function handleDrainPool(all: boolean): Promise<Response> {
  return handleDrainPoolHandler(all, drainPoolDeps);
}

// Pure orchestration extracted to lib/handlers/lease.ts.
const releaseLeaseDeps: ReleaseLeaseDeps = { releaseLease };
const flushLeasesDeps: FlushLeasesDeps = { computeOrphanLeases, releaseLease };
async function handleReleaseLease(hostname: string): Promise<Response> {
  return handleReleaseLeaseHandler(hostname, releaseLeaseDeps);
}
async function handleFlushLeases(): Promise<Response> {
  return handleFlushLeasesHandler(flushLeasesDeps);
}

// Pure orchestration extracted to lib/handlers/image.ts.
const getImageDeps: GetImageDeps = { imageMeta };
const deleteImageDeps: DeleteImageDeps = { removeImage };
const saveImageDeps: SaveImageDeps = {
  lumeInfo: async (n) => {
    const lume = new LumeClient();
    return lume.info(n).catch(() => null);
  },
  resolveLumeName,
  resolveWellIp,
  probeImageSource,
  rinseGuest,
  waitForDiskReleased,
  transitionWellStop: (n) => transitionWell(n, "stop", defaultActuators),
  saveImage,
  vmSshKey: PATHS.vmSshKey,
  bundleDiskPath,
};
function resolveR2FromReq(req: Request) {
  return resolveR2LibraryConfigHandler(req, {
    endpoint: process.env.WELL_R2_LIBRARY_ENDPOINT,
    bucket: process.env.WELL_R2_LIBRARY_BUCKET,
    access_key_id: process.env.WELL_R2_LIBRARY_ACCESS_KEY_ID,
    secret_access_key: process.env.WELL_R2_LIBRARY_SECRET_ACCESS_KEY,
  });
}
const pushImageDeps: PushImageDeps = {
  resolveR2Config: resolveR2FromReq,
  pushImage,
  version: VERSION,
};
const pullImageDeps: PullImageDeps = {
  resolveR2Config: resolveR2FromReq,
  pullImage,
};
async function handleGetImage(name: string): Promise<Response> {
  return handleGetImageHandler(name, getImageDeps);
}
async function handleSaveImage(req: Request): Promise<Response> {
  return handleSaveImageHandler(req, saveImageDeps);
}
async function handleDeleteImage(name: string): Promise<Response> {
  return handleDeleteImageHandler(name, deleteImageDeps);
}
async function handlePushImage(name: string, req: Request): Promise<Response> {
  return handlePushImageHandler(name, req, pushImageDeps);
}
async function handlePullImage(name: string, req: Request): Promise<Response> {
  return handlePullImageHandler(name, req, pullImageDeps);
}

// Pure orchestration extracted to lib/handlers/checkpoint.ts.
const createCheckpointDeps: CreateCheckpointDeps = {
  findWell,
  ensureRunning,
  createCheckpoint,
  listCheckpoints,
  parseDuration,
};
const listCheckpointsDeps: ListCheckpointsDeps = { findWell, listCheckpoints };
const expireCheckpointDeps: ExpireCheckpointDeps = { findWell, expireCheckpoint };
const restoreCheckpointDeps: RestoreCheckpointDeps = {
  findWell,
  restoreCheckpoint,
  buildWellResource,
};
async function handleCreateCheckpoint(name: string, req: Request): Promise<Response> {
  return handleCreateCheckpointHandler(name, req, createCheckpointDeps);
}
async function handleListCheckpoints(name: string): Promise<Response> {
  return handleListCheckpointsHandler(name, listCheckpointsDeps);
}
async function handleExpireCheckpoint(name: string, id: string): Promise<Response> {
  return handleExpireCheckpointHandler(name, id, expireCheckpointDeps);
}
async function handleRestoreCheckpoint(
  name: string,
  id: string,
  fromR2: boolean,
): Promise<Response> {
  return handleRestoreCheckpointHandler(name, id, fromR2, restoreCheckpointDeps);
}

// Pure orchestration extracted to lib/handlers/wellMeta.ts.
const setNetworkPolicyDeps: SetNetworkPolicyDeps = {
  findWell,
  writePolicy: async (name, rules) => {
    const path = PATHS.vmPolicy(name);
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await Bun.write(tmp, JSON.stringify({ rules }, null, 2));
    await rename(tmp, path);
  },
};
const getNetworkPolicyDeps: GetNetworkPolicyDeps = {
  findWell,
  readPolicy: async (name) => {
    try {
      const raw = await Bun.file(PATHS.vmPolicy(name)).text();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.rules)) return parsed.rules;
      return null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("policy read failed, returning empty", { name, err: (e as Error).message });
      }
      return null;
    }
  },
};
const patchWellDeps: PatchWellDeps = {
  findWell,
  updateWellAutoSleep,
  buildWellResource,
};
const updateUrlDeps: UpdateUrlDeps = { updateWellAuth, buildWellResource };
async function handleNetworkPolicy(name: string, req: Request): Promise<Response> {
  return handleNetworkPolicyHandler(name, req, setNetworkPolicyDeps);
}
async function handleGetNetworkPolicy(name: string): Promise<Response> {
  return handleGetNetworkPolicyHandler(name, getNetworkPolicyDeps);
}
async function handlePatchWell(name: string, req: Request): Promise<Response> {
  return handlePatchWellHandler(name, req, patchWellDeps);
}
async function handleUpdateUrl(name: string, req: Request): Promise<Response> {
  return handleUpdateUrlHandler(name, req, updateUrlDeps);
}

// Pure orchestration extracted to lib/handlers/destroyWell.ts. The
// in-memory state cleanup (clearLastTouched, watchdog failure counter)
// is daemon-owned state that destroyWell can't reach — wired here.
const destroyWellDeps: DestroyWellDeps = {
  destroyWell,
  clearLastTouched,
  clearWatchdogFailures: (n) => {
    watchdogHibFailures.delete(n);
  },
};
async function handleDestroyWell(name: string): Promise<Response> {
  return handleDestroyWellHandler(name, destroyWellDeps);
}

// Synchronous HTTP exec — buffer stdout/stderr to a hard cap and return
// JSON. Mirrors the shell-escape handling from the WS handler so scripts
// with metacharacters round-trip correctly. The cap exists to prevent a
// runaway guest from filling the daemon's heap; on overflow we kill the
// ssh proc and emit `truncated: true`. Pure orchestration extracted to
// lib/handlers/httpExec.ts; the ssh subprocess + stream drain stays here
// as the injected runner.
const EXEC_OUTPUT_CAP_BYTES = 4 * 1024 * 1024;

async function runHttpExecSsh(opts: {
  name: string;
  ip: string;
  user: string;
  command: string[];
  capBytes: number;
}): Promise<{ exit_code: number; stdout: string; stderr: string; truncated: boolean }> {
  await ensureSshMaster({
    name: opts.name,
    ip: opts.ip,
    user: "well",
    keyPath: PATHS.vmSshKey(opts.name),
  });
  const innerCmd = opts.command.map(shellEscape).join(" ");
  const remoteCmd =
    opts.user === "well"
      ? innerCmd
      : `sudo -n -u ${shellEscape(opts.user)} bash -c ${shellEscape(innerCmd)}`;
  const proc = spawn(
    [
      "ssh",
      ...sshControlArgs(opts.name),
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-i", PATHS.vmSshKey(opts.name),
      `well@${opts.ip}`,
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
        if (total + value.length > opts.capBytes) {
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
  return { exit_code: exit, stdout, stderr, truncated };
}

const httpExecDeps: HttpExecDeps = {
  findWell,
  ensureRunning,
  resolveWellIp,
  runExec: runHttpExecSsh,
  capBytes: EXEC_OUTPUT_CAP_BYTES,
};
async function handleHttpExec(name: string, req: Request): Promise<Response> {
  return handleHttpExecHandler(name, req, httpExecDeps);
}

// Pure orchestration extracted to lib/handlers/service.ts.
const putServiceDeps: PutServiceDeps = { findWell, ensureRunning, putService };
const deleteServiceDeps: DeleteServiceDeps = { findWell, ensureRunning, deleteService };
const getServiceDeps: GetServiceDeps = { findWell, getService };
const listServicesDeps: ListServicesDeps = { findWell, listServices };
async function handlePutService(well: string, id: string, req: Request): Promise<Response> {
  return handlePutServiceHandler(well, id, req, putServiceDeps);
}
async function handleDeleteService(well: string, id: string): Promise<Response> {
  return handleDeleteServiceHandler(well, id, deleteServiceDeps);
}
async function handleGetService(well: string, id: string): Promise<Response> {
  return handleGetServiceHandler(well, id, getServiceDeps);
}
async function handleListServices(well: string): Promise<Response> {
  return handleListServicesHandler(well, listServicesDeps);
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

// Pure implementation extracted to lib/bridgeIp.ts.
function findBridgeIp(): string | null {
  return findBridgeIpFromInterfaces(networkInterfaces());
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
