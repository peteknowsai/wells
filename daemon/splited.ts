#!/usr/bin/env bun
// splited — the splites daemon. HTTP on :7878. Sprites-shaped REST.
// Phase 0+1: /healthz, supervises lume serve. Phase 8 lands the rest.

import { spawn, type Subprocess } from "bun";
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
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from "../lib/checkpoints.ts";
import {
  CheckpointResource,
  CheckpointsListResponse,
  CreateSpliteRequest,
  DestroyResponse,
  SpliteResource,
  SplitesListResponse,
  type SpliteSummary,
} from "../lib/schemas.ts";
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

interface ExecSession {
  name: string;
  ssh: Subprocess<"pipe", "pipe", "pipe"> | null;
}

const server = Bun.serve<ExecSession>({
  port: PORT,
  hostname: "127.0.0.1",
  // Default is 10s; our long-pole endpoints (create ~30s, restore ~15s,
  // stop ~12s) all blow past it. 255 is Bun's max — about 4 min, which
  // accommodates a slow guest cloud-init without cutting clients off.
  idleTimeout: 255,
  fetch(req, srv) {
    const url = new URL(req.url);

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
      const ok = srv.upgrade(req, { data: { name, ssh: null } satisfies ExecSession });
      if (ok) return undefined;
      return new Response("ws upgrade failed\n", { status: 400 });
    }

    if (!authorized(req, url)) return unauthorized();

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
      if (req.method === "POST") return handleCreateCheckpoint(name);
      if (req.method === "GET") return handleListCheckpoints(name);
    }

    const restore = /^\/v1\/splites\/([^/]+)\/checkpoints\/([^/]+)\/restore$/.exec(url.pathname);
    if (restore && req.method === "POST") {
      const name = decodeURIComponent(restore[1]!);
      const id = decodeURIComponent(restore[2]!);
      return handleRestoreCheckpoint(name, id);
    }

    return new Response("not found\n", { status: 404 });
  },
  websocket: {
    async open(ws) {
      // Wait for the client's first frame (the start spec) before doing
      // anything. Browsers connect, then we expect a JSON frame:
      //   {type:"start", cmd:["bash","-c","echo hi"], tty?:false}
      ws.send(JSON.stringify({ type: "ready" }));
    },
    async message(ws, raw) {
      const data = ws.data;
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
      // Client hung up — kill the ssh subprocess so we don't leak it.
      ws.data.ssh?.kill();
    },
  },
});

function shellEscape(s: string): string {
  // Allow safe-by-default chars; everything else gets single-quoted.
  if (/^[A-Za-z0-9_/.@:=+-]+$/.test(s) && s.length > 0) return s;
  return "'" + s.replaceAll("'", "'\\''") + "'";
}

async function pipeStreamToWs(
  stream: ReadableStream<Uint8Array>,
  ws: Bun.ServerWebSocket<ExecSession>,
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
        url: null,           // Phase 9 lights this up via Cloudflare Tunnel.
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
  return {
    name: record.name,
    uuid: record.uuid,
    status,
    url: null,
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

async function handleCreateCheckpoint(name: string): Promise<Response> {
  const record = await findSplite(name);
  if (!record) return apiError(404, "not_found", `splite '${name}' not found`);
  let cp;
  try {
    cp = await createCheckpoint(name);
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
