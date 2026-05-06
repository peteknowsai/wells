#!/usr/bin/env bun
// splited — the splites daemon. HTTP on :7878. Sprites-shaped REST.
// Phase 0+1: /healthz, supervises lume serve. Phase 8 lands the rest.

import { Value } from "@sinclair/typebox/value";
import { ensureLumeServe, stopLumeServe, type LumeHandle } from "../engine/lumeProcess.ts";
import { LumeClient, type VMSummary } from "../engine/lume.ts";
import { ensureStateDirs } from "../lib/state.ts";
import { ensureToken } from "../lib/token.ts";
import { findSplite, listSplites } from "../lib/registry.ts";
import { readDhcpLease } from "../lib/dhcp.ts";
import { diskUsageBytes } from "../lib/createSplite.ts";
import { startSplite, stopSplite } from "../lib/lifecycle.ts";
import {
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

function authorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  // RFC6750: "Bearer <token>". Case-insensitive scheme.
  const m = /^bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) return false;
  // Constant-time compare avoids timing-leak nitpicks on token check.
  return timingSafeEqual(m[1]!, TOKEN);
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

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  // Default is 10s; our long-pole endpoints (create ~30s, restore ~15s,
  // stop ~12s) all blow past it. 255 is Bun's max — about 4 min, which
  // accommodates a slow guest cloud-init without cutting clients off.
  idleTimeout: 255,
  fetch(req) {
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

    if (!authorized(req)) return unauthorized();

    if (req.method === "GET" && url.pathname === "/v1/whoami") {
      return Response.json({ ok: true, scope: "splited" });
    }

    if (req.method === "GET" && url.pathname === "/v1/splites") {
      return handleListSplites();
    }

    const m = /^\/v1\/splites\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const name = decodeURIComponent(m[1]!);
      if (req.method === "GET") return handleGetSplite(name);
    }

    const action = /^\/v1\/splites\/([^/]+)\/(start|stop)$/.exec(url.pathname);
    if (action && req.method === "POST") {
      const name = decodeURIComponent(action[1]!);
      const verb = action[2] as "start" | "stop";
      return handleLifecycle(name, verb);
    }

    return new Response("not found\n", { status: 404 });
  },
});

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
