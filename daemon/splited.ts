#!/usr/bin/env bun
// splited — the splites daemon. HTTP on :7878. Sprites-shaped REST.
// Phase 0+1: /healthz, supervises lume serve. Phase 8 lands the rest.

import { spawn, type Subprocess } from "bun";
import { rename } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { ensureLumeServe, stopLumeServe, type LumeHandle } from "../engine/lumeProcess.ts";
import { LumeClient, type VMSummary } from "../engine/lume.ts";
import { ensureStateDirs } from "../lib/state.ts";
import { ensureToken } from "../lib/token.ts";
import { findSplite, listSplites } from "../lib/registry.ts";
import { readDhcpLease } from "../lib/dhcp.ts";
import { PATHS } from "../lib/state.ts";
import { createSplite, diskUsageBytes } from "../lib/createSplite.ts";
import { destroySplite } from "../lib/destroy.ts";
import { startSplite, stopSplite } from "../lib/lifecycle.ts";
import {
  extractSpliteFromHost,
  proxyHttp,
  publicBase,
  resolveProxyTarget,
  upstreamWsUrl,
} from "../lib/proxy.ts";
import {
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from "../lib/checkpoints.ts";
import {
  CheckpointResource,
  CheckpointsListResponse,
  CreateSpliteRequest,
  DestroyResponse,
  ExecRequest,
  type ExecResponse,
  NetworkPolicyRequest,
  NetworkPolicyResponse,
  ServiceDefinition,
  ServiceResource,
  ServicesListResponse,
  SpliteResource,
  SplitesListResponse,
  type SpliteSummary,
  UrlUpdateRequest,
} from "../lib/schemas.ts";
import {
  deleteService,
  getService,
  listServices,
  putService,
} from "../lib/services.ts";
import { updateSpliteAuth } from "../lib/registry.ts";
import { shellEscape } from "../lib/shellEscape.ts";
import { touch } from "../lib/idle.ts";
import { log } from "../lib/log.ts";

const PORT = Number(process.env.SPLITES_PORT ?? 7878);
const VERSION = "0.1.0-pre";

const startedAt = new Date().toISOString();

await ensureStateDirs();
const TOKEN = await ensureToken();
const lumeHandle: LumeHandle = await ensureLumeServe();

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
    headers: { "WWW-Authenticate": 'Bearer realm="splited"' },
  });
}

type WsSession =
  | { kind: "exec"; name: string; ssh: Subprocess<"pipe", "pipe", "pipe"> | null }
  | {
      kind: "proxy";
      splite: string;
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

    // Path alias: /v1/sprites/... → /v1/splites/.... Cells (and any other
    // sprites-shaped client) doesn't know we exist; this rewrite at the
    // top of fetch() means everything downstream sees the canonical path.
    // Done before the proxy branch is unnecessary (proxy is Host-keyed,
    // not path-keyed) but harmless — keeps the path consistent everywhere.
    if (url.pathname.startsWith("/v1/sprites/")) {
      url.pathname = "/v1/splites/" + url.pathname.slice("/v1/sprites/".length);
    }

    // Reverse-proxy branch — when the Host header matches the configured
    // public base (e.g. "pete.splites.cells.md" with SPLITES_PUBLIC_BASE
    // = "splites.cells.md"), forward the request to the splite's guest:8080.
    // This is what cloudflared dials. No bearer auth on this path — the
    // splite's own app handles auth.
    const base = publicBase();
    if (base) {
      const splite = extractSpliteFromHost(req.headers.get("host"), base);
      if (splite) {
        const target = await resolveProxyTarget(splite);
        if (!target) {
          return new Response(`splite '${splite}' not found or not running\n`, {
            status: 502,
            headers: { "content-type": "text/plain" },
          });
        }
        // Per-splite auth gate: when the record's `auth` is "splite", the
        // proxy demands a Bearer token before forwarding. "public" mode
        // (cells's hatched cells) skips auth entirely.
        if (target.auth === "splite" && !authorized(req, url)) {
          return unauthorized();
        }
        // Proxy traffic counts as activity for the autosleep watchdog.
        touch(target.splite);
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const ok = srv.upgrade(req, {
            data: {
              kind: "proxy",
              splite: target.splite,
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
    const wsExec = /^\/v1\/splites\/([^/]+)\/exec$/.exec(url.pathname);
    if (wsExec && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!authorized(req, url)) return unauthorized();
      const name = decodeURIComponent(wsExec[1]!);
      touch(name);
      const ok = srv.upgrade(req, {
        data: { kind: "exec", name, ssh: null } satisfies WsSession,
      });
      if (ok) return undefined;
      return new Response("ws upgrade failed\n", { status: 400 });
    }

    if (!authorized(req, url)) return unauthorized();

    // Authed activity on a per-splite path counts as a touch for the
    // autosleep watchdog. The regex captures every `/v1/splites/{n}/...`
    // (and the bare `/v1/splites/{n}`) — list/whoami don't match and
    // correctly don't bump anything.
    const touchMatch = /^\/v1\/splites\/([^/]+)/.exec(url.pathname);
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
      return Response.json({ ok: true, scope: "splited" });
    }

    if (url.pathname === "/v1/splites") {
      if (req.method === "GET") return handleListSplites();
      if (req.method === "POST") return handleCreateSplite(req);
    }

    const m = /^\/v1\/splites\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const name = decodeURIComponent(m[1]!);
      if (req.method === "GET") return handleGetSplite(name);
      if (req.method === "DELETE") return handleDestroySplite(name);
    }

    const action = /^\/v1\/splites\/([^/]+)\/(start|stop)$/.exec(url.pathname);
    if (action && req.method === "POST") {
      const name = decodeURIComponent(action[1]!);
      const verb = action[2] as "start" | "stop";
      return handleLifecycle(name, verb);
    }

    const cps = /^\/v1\/splites\/([^/]+)\/checkpoints$/.exec(url.pathname);
    if (cps) {
      const name = decodeURIComponent(cps[1]!);
      if (req.method === "POST") return handleCreateCheckpoint(name, req);
      if (req.method === "GET") return handleListCheckpoints(name);
    }

    const restore = /^\/v1\/splites\/([^/]+)\/checkpoints\/([^/]+)\/restore$/.exec(url.pathname);
    if (restore && req.method === "POST") {
      const name = decodeURIComponent(restore[1]!);
      const id = decodeURIComponent(restore[2]!);
      return handleRestoreCheckpoint(name, id);
    }

    const policy = /^\/v1\/splites\/([^/]+)\/policy\/network$/.exec(url.pathname);
    if (policy) {
      const name = decodeURIComponent(policy[1]!);
      if (req.method === "POST") return handleNetworkPolicy(name, req);
      if (req.method === "GET") return handleGetNetworkPolicy(name);
    }

    const services = /^\/v1\/splites\/([^/]+)\/services$/.exec(url.pathname);
    if (services && req.method === "GET") {
      return handleListServices(decodeURIComponent(services[1]!));
    }

    const service = /^\/v1\/splites\/([^/]+)\/services\/([^/]+)$/.exec(url.pathname);
    if (service) {
      const name = decodeURIComponent(service[1]!);
      const id = decodeURIComponent(service[2]!);
      if (req.method === "PUT") return handlePutService(name, id, req);
      if (req.method === "DELETE") return handleDeleteService(name, id);
      if (req.method === "GET") return handleGetService(name, id);
    }

    const urlRoute = /^\/v1\/splites\/([^/]+)\/url$/.exec(url.pathname);
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
      // Long-running WS sessions (exec, proxy) keep the splite alive
      // — touch on every frame so the watchdog doesn't stop it mid-call.
      touch(data.kind === "proxy" ? data.splite : data.name);
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
        const record = await findSplite(data.name);
        if (!record) {
          ws.send(JSON.stringify({ type: "error", message: `splite '${data.name}' not found` }));
          ws.close(1011);
          return;
        }
        const ip = await readDhcpLease(data.name);
        if (!ip) {
          ws.send(JSON.stringify({ type: "error", message: `splite '${data.name}' has no DHCP lease` }));
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

async function handleListSplites(): Promise<Response> {
  const splites = await listSplites();
  const lume = new LumeClient();
  const lumeList = await lume.list().catch(() => [] as VMSummary[]);
  const lumeByName = new Map(lumeList.map((v) => [v.name, v]));

  const base = publicBase();
  const rows: SpliteSummary[] = await Promise.all(
    splites.map(async (s) => {
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

  const body = { splites: rows };
  // Self-validate before responding — catches drift between the engine
  // shape and the API shape early. In prod this is a should-never-fire
  // guardrail; in dev it's a fast feedback loop on schema edits.
  if (!Value.Check(SplitesListResponse, body)) {
    log.error("response shape failed validation", {
      route: "/v1/splites",
      errors: [...Value.Errors(SplitesListResponse, body)].slice(0, 3),
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}

async function buildSpliteResource(name: string) {
  const record = await findSplite(name);
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
  };
}

function spliteResourceResponse(body: unknown, route: string): Response {
  if (!Value.Check(SpliteResource, body)) {
    log.error("response shape failed validation", {
      route,
      errors: [...Value.Errors(SpliteResource, body)].slice(0, 3),
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}

async function handleGetSplite(name: string): Promise<Response> {
  const body = await buildSpliteResource(name);
  if (!body) return apiError(404, "not_found", `splite '${name}' not found`);
  return spliteResourceResponse(body, `/v1/splites/${name}`);
}

async function handleLifecycle(
  name: string,
  verb: "start" | "stop",
): Promise<Response> {
  const record = await findSplite(name);
  if (!record) return apiError(404, "not_found", `splite '${name}' not found`);

  try {
    if (verb === "start") await startSplite(name);
    else await stopSplite(name);
  } catch (e) {
    return apiError(500, `${verb}_failed`, (e as Error).message);
  }

  const body = await buildSpliteResource(name);
  if (!body) return apiError(500, "vanished", `splite '${name}' disappeared mid-${verb}`);
  return spliteResourceResponse(body, `/v1/splites/${name}/${verb}`);
}

async function handleCreateSplite(req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(CreateSpliteRequest, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(CreateSpliteRequest, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const body = parsed as CreateSpliteRequest;

  try {
    await createSplite({
      name: body.name,
      cpu: body.cpu,
      memory: body.memory,
      disk: body.disk,
    });
  } catch (e) {
    return apiError(400, "create_failed", (e as Error).message);
  }

  const resource = await buildSpliteResource(body.name);
  if (!resource) {
    return apiError(500, "vanished", `splite '${body.name}' missing post-create`);
  }
  if (!Value.Check(SpliteResource, resource)) {
    log.error("response shape failed validation", { route: "POST /v1/splites" });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(resource, { status: 201 });
}

async function handleCreateCheckpoint(name: string, req: Request): Promise<Response> {
  const record = await findSplite(name);
  if (!record) return apiError(404, "not_found", `splite '${name}' not found`);
  // Body is optional. Empty body is fine (most callers don't send one).
  let comment: string | undefined;
  if (req.headers.get("content-length") && req.headers.get("content-length") !== "0") {
    try {
      const body = await req.json() as { comment?: unknown };
      if (typeof body?.comment === "string") comment = body.comment;
    } catch {
      // Treat unparseable body as no comment — sprites is lenient here.
    }
  }
  let cp;
  try {
    cp = await createCheckpoint(name, { comment });
  } catch (e) {
    return apiError(500, "checkpoint_failed", (e as Error).message);
  }
  // Re-list to pick up physical_bytes (computed at list time from st_blocks).
  const all = await listCheckpoints(name);
  const fresh = all.find((c) => c.id === cp.id);
  if (!fresh) return apiError(500, "checkpoint_vanished", `checkpoint '${cp.id}' missing post-create`);
  if (!Value.Check(CheckpointResource, fresh)) {
    log.error("response shape failed validation", {
      route: `POST /v1/splites/${name}/checkpoints`,
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(fresh, { status: 201 });
}

async function handleListCheckpoints(name: string): Promise<Response> {
  const record = await findSplite(name);
  if (!record) return apiError(404, "not_found", `splite '${name}' not found`);
  const checkpoints = await listCheckpoints(name);
  const body = { checkpoints };
  if (!Value.Check(CheckpointsListResponse, body)) {
    log.error("response shape failed validation", {
      route: `GET /v1/splites/${name}/checkpoints`,
      errors: [...Value.Errors(CheckpointsListResponse, body)].slice(0, 3),
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}

async function handleRestoreCheckpoint(name: string, id: string): Promise<Response> {
  const record = await findSplite(name);
  if (!record) return apiError(404, "not_found", `splite '${name}' not found`);
  try {
    await restoreCheckpoint(name, id);
  } catch (e) {
    const msg = (e as Error).message;
    const status = /not found/i.test(msg) ? 404 : 500;
    return apiError(status, "restore_failed", msg);
  }
  const body = await buildSpliteResource(name);
  if (!body) return apiError(500, "vanished", `splite '${name}' missing post-restore`);
  return spliteResourceResponse(body, `POST /v1/splites/${name}/checkpoints/${id}/restore`);
}

async function handleNetworkPolicy(name: string, req: Request): Promise<Response> {
  const record = await findSplite(name);
  if (!record) return apiError(404, "not_found", `splite '${name}' not found`);

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
  // a registered splite so we don't need to mkdir. Phase A still owes
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
      route: `POST /v1/splites/${name}/policy/network`,
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(response);
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
  const updated = await updateSpliteAuth(name, body.auth);
  if (!updated) return apiError(404, "not_found", `splite '${name}' not found`);

  const resource = await buildSpliteResource(name);
  if (!resource) return apiError(500, "vanished", `splite '${name}' missing post-update`);
  return spliteResourceResponse(resource, `PUT /v1/splites/${name}/url`);
}

// GET counterpart — cells reads `policy.rules[*].{action, domain}`, tolerates
// 404/empty (`.catch(() => null)` on the cells side). We always 200 the
// success path; on ENOENT or invalid-shape we return `{rules: []}`.
async function handleGetNetworkPolicy(name: string): Promise<Response> {
  const record = await findSplite(name);
  if (!record) return apiError(404, "not_found", `splite '${name}' not found`);
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

async function handleDestroySplite(name: string): Promise<Response> {
  let r;
  try {
    r = await destroySplite(name);
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
    log.error("response shape failed validation", { route: `DELETE /v1/splites/${name}` });
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
  const record = await findSplite(name);
  if (!record) return apiError(404, "not_found", `splite '${name}' not found`);

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
    return apiError(409, "no_lease", `splite '${name}' has no DHCP lease — start it first`);
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

async function handlePutService(splite: string, id: string, req: Request): Promise<Response> {
  const record = await findSplite(splite);
  if (!record) return apiError(404, "not_found", `splite '${splite}' not found`);

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
    resource = await putService(splite, id, def);
  } catch (e) {
    const msg = (e as Error).message;
    const status = /invalid/i.test(msg) ? 400 : 500;
    return apiError(status, "service_apply_failed", msg);
  }
  if (!Value.Check(ServiceResource, resource)) {
    log.error("response shape failed validation", {
      route: `PUT /v1/splites/${splite}/services/${id}`,
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(resource);
}

async function handleDeleteService(splite: string, id: string): Promise<Response> {
  const record = await findSplite(splite);
  if (!record) return apiError(404, "not_found", `splite '${splite}' not found`);
  let found: boolean;
  try {
    found = await deleteService(splite, id);
  } catch (e) {
    return apiError(500, "service_delete_failed", (e as Error).message);
  }
  return Response.json({ id, splite, found });
}

async function handleGetService(splite: string, id: string): Promise<Response> {
  const record = await findSplite(splite);
  if (!record) return apiError(404, "not_found", `splite '${splite}' not found`);
  let resource;
  try {
    resource = await getService(splite, id);
  } catch (e) {
    return apiError(400, "bad_request", (e as Error).message);
  }
  if (!resource) return apiError(404, "not_found", `service '${id}' not found on splite '${splite}'`);
  if (!Value.Check(ServiceResource, resource)) {
    log.error("response shape failed validation", {
      route: `GET /v1/splites/${splite}/services/${id}`,
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(resource);
}

async function handleListServices(splite: string): Promise<Response> {
  const record = await findSplite(splite);
  if (!record) return apiError(404, "not_found", `splite '${splite}' not found`);
  const services = await listServices(splite);
  const body = { services };
  if (!Value.Check(ServicesListResponse, body)) {
    log.error("response shape failed validation", {
      route: `GET /v1/splites/${splite}/services`,
      errors: [...Value.Errors(ServicesListResponse, body)].slice(0, 3),
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}

log.info("splited listening", {
  url: `http://${server.hostname}:${server.port}`,
  token_path: "~/.splites/token",
});

const shutdown = () => {
  log.info("splited shutting down");
  server.stop();
  stopLumeServe(lumeHandle);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
