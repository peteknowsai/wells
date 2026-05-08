#!/usr/bin/env bun
// welld — the wells daemon. HTTP on :7878. Sprites-shaped REST.
// Phase 0+1: /healthz, supervises lume serve. Phase 8 lands the rest.

import { spawn, type Subprocess } from "bun";
import { rename } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { ensureLumeServe, stopLumeServe, type LumeHandle } from "../engine/lumeProcess.ts";
import { LumeClient, type VMSummary } from "../engine/lume.ts";
import { ensureStateDirs } from "../lib/state.ts";
import { ensureToken } from "../lib/token.ts";
import { findWell, listWells } from "../lib/registry.ts";
import { findWellByIp, readDhcpLease } from "../lib/dhcp.ts";
import { isBusy, markIdle, markWorking } from "../lib/cellState.ts";
import { networkInterfaces } from "node:os";
import { PATHS } from "../lib/state.ts";
import { createWell, diskUsageBytes } from "../lib/createWell.ts";
import { destroyWell } from "../lib/destroy.ts";
import { sleepWell, startWell, stopWell } from "../lib/lifecycle.ts";
import {
  extractWellFromHost,
  proxyHttp,
  publicBase,
  resolveProxyTarget,
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
  deleteService,
  getService,
  listServices,
  putService,
} from "../lib/services.ts";
import { updateWellAuth, updateWellAutoSleep } from "../lib/registry.ts";
import { shellEscape } from "../lib/shellEscape.ts";
import { getLastTouched, touch } from "../lib/idle.ts";
import { sampleActivity } from "../lib/activity.ts";
import { runWatchdogTick } from "../lib/watchdog.ts";
import { sweepDanglingLumeRun } from "../lib/lumeRunGc.ts";
import { loadDefaults } from "../lib/defaults.ts";
import { ensureRunning } from "../lib/wake.ts";
import { log } from "../lib/log.ts";

const PORT = Number(process.env.WELL_PORT ?? 7878);
const VERSION = "0.1.0-pre";

const startedAt = new Date().toISOString();

await ensureStateDirs();
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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function unauthorized(): Response {
  return new Response("unauthorized\n", {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="welld"' },
  });
}

type WsSession =
  | { kind: "exec"; name: string; ssh: Subprocess<"pipe", "pipe", "pipe"> | null }
  | {
      kind: "proxy";
      well: string;
      upstreamUrl: string;
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
    // Both the bare list endpoint (/v1/sprites) and resource endpoints
    // (/v1/sprites/<name>/...) get aliased.
    if (url.pathname === "/v1/sprites") {
      url.pathname = "/v1/wells";
    } else if (url.pathname.startsWith("/v1/sprites/")) {
      url.pathname = "/v1/wells/" + url.pathname.slice("/v1/sprites/".length);
    }

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
      return Response.json({
        ok: true,
        version: VERSION,
        started_at: startedAt,
        lume: { base_url: lumeHandle.baseUrl, owned: lumeHandle.spawned !== null },
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
        // received before upstream is open get queued.
        const out = new WebSocket(d.upstreamUrl);
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
      let frame: { type?: string; cmd?: unknown; tty?: unknown; data?: unknown };
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
        const ip = await readDhcpLease(data.name);
        if (!ip) {
          ws.send(JSON.stringify({ type: "error", message: `well '${data.name}' has no DHCP lease` }));
          ws.close(1011);
          return;
        }

        const tty = frame.tty === true;
        // ssh joins post-host args with spaces and the remote shell parses
        // them — so any metacharacter in cmd[] (`;`, `&&`, quotes, spaces)
        // gets re-interpreted by bash on the other side. Shell-escape each
        // arg and pass the joined string as ONE arg to ssh.
        const remoteCmd = (frame.cmd as string[]).map(shellEscape).join(" ");
        const sshArgs = [
          "ssh",
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          "-o", "LogLevel=ERROR",
          "-i", PATHS.vmSshKey(data.name),
          ...(tty ? ["-tt"] : []),
          `ubuntu@${ip}`,
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
        proc.exited.then(async (code) => {
          await Promise.allSettled(pipes);
          try { ws.send(JSON.stringify({ type: "exit", code })); } catch {}
          ws.close();
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

function apiError(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
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
      const ip = await readDhcpLease(s.name);
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
  const lumeInfo = await lume.info(name).catch(() => null);
  const status =
    typeof lumeInfo?.status === "string"
      ? (lumeInfo.status as "running" | "stopped")
      : "missing";
  const ip = await readDhcpLease(name);
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
    // For start, use ensureRunning so a paused well unpauses too.
    // The daemon treats POST /start as "make this well alive" — the
    // CLI's `well exec` and the cells team's automation rely on it
    // being idempotent across stopped/paused/running states. Bare
    // startWell would no-op on a paused well and leave SSH hanging.
    if (verb === "start") await ensureRunning(name, 60_000);
    else await stopWell(name);
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

  try {
    await createWell({
      name: body.name,
      cpu: body.cpu,
      memory: body.memory,
      disk: body.disk,
      ...(body.r2 ? { r2: body.r2 } : {}),
      ...(body.env ? { env: body.env } : {}),
    });
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

  const ip = await readDhcpLease(name);
  if (!ip) {
    return apiError(409, "no_lease", `well '${name}' has no DHCP lease — start it first`);
  }

  const remoteCmd = body.command.map(shellEscape).join(" ");
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-i", PATHS.vmSshKey(name),
      `ubuntu@${ip}`,
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
const bridgeIp = findBridgeIp();
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

      const me = `/v1/cells/me/`;
      if (!url.pathname.startsWith(me)) {
        return new Response("not found\n", { status: 404 });
      }
      const verb = url.pathname.slice(me.length);

      if (verb === "working") {
        markWorking(name);
        log.info("cell signaled working", { name });
        return Response.json({ ok: true, name, state: "working" });
      }
      if (verb === "sleep") {
        markIdle(name);
        // Defer the actual pause so the response can flush before
        // the VM freezes (the response goes through the same vmnet
        // bridge that's about to halt). Trust the agent's call;
        // any "did they really mean it" validation belongs in the
        // hook that wraps this call, not here.
        queueMicrotask(async () => {
          try {
            await sleepWell(name);
            log.info("cell self-paused", { name });
          } catch (e) {
            log.error("cell sleep failed", {
              name,
              err: (e as Error).message,
            });
          }
        });
        return Response.json({ ok: true, name, state: "sleeping" });
      }
      return new Response(`unknown verb ${verb}\n`, { status: 404 });
    },
  });
  log.info("cell metadata server up", {
    url: `http://${metadataServer.hostname}:${metadataServer.port}`,
  });
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
  const runningNames = new Set(
    lumeList.filter((v) => v.status === "running").map((v) => v.name),
  );

  const slept = await runWatchdogTick({
    records,
    isRunning: (n) => runningNames.has(n),
    lastTouchedMs: getLastTouched,
    nowMs: Date.now(),
    defaultSeconds: defaults.auto_sleep_seconds,
    stopWell: async (n) => {
      // "Sleep" = pause (alive, CPU off). Hibernation lands later;
      // explicit user `well stop` still uses stopWell for full
      // shutdown. See docs/lifecycle.md.
      log.info("watchdog: pausing idle well", { name: n });
      await sleepWell(n);
    },
    probeActivity: async (n) => {
      // Cooperative agent signal trumps every other heuristic. Set
      // via /v1/cells/me/working from inside the cell.
      if (isBusy(n)) return true;
      const ip = await readDhcpLease(n);
      if (!ip) return false;
      const sample = await sampleActivity(ip);
      return sample.isActive;
    },
  });
  if (slept.length > 0) {
    log.info("watchdog: tick paused wells", { paused: slept });
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

log.info("welld listening", {
  url: `http://${server.hostname}:${server.port}`,
  token_path: "~/.wells/token",
});

const shutdown = () => {
  log.info("welld shutting down");
  clearInterval(watchdogTimer);
  server.stop();
  stopLumeServe(lumeHandle);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
