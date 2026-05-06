#!/usr/bin/env bun
// splited — the splites daemon. HTTP on :7878. Sprites-shaped REST.
// Phase 0+1: /healthz, supervises lume serve. Phase 8 lands the rest.

import { ensureLumeServe, stopLumeServe, type LumeHandle } from "../engine/lumeProcess.ts";
import { ensureStateDirs } from "../lib/state.ts";
import { ensureToken } from "../lib/token.ts";
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

    return new Response("not found\n", { status: 404 });
  },
});

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
