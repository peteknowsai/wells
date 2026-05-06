#!/usr/bin/env bun
// splited — the splites daemon. HTTP on :7878. Sprites-shaped REST.
// Phase 0+1: /healthz, supervises lume serve. Real endpoints land in phase 8.

import { ensureLumeServe, stopLumeServe, type LumeHandle } from "../engine/lumeProcess.ts";
import { log } from "../lib/log.ts";

const PORT = Number(process.env.SPLITES_PORT ?? 7878);
const VERSION = "0.1.0-pre";

const startedAt = new Date().toISOString();

const lumeHandle: LumeHandle = await ensureLumeServe();

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        version: VERSION,
        started_at: startedAt,
        lume: { base_url: lumeHandle.baseUrl, owned: lumeHandle.spawned !== null },
      });
    }
    return new Response("not found\n", { status: 404 });
  },
});

log.info("splited listening", { url: `http://${server.hostname}:${server.port}` });

const shutdown = () => {
  log.info("splited shutting down");
  server.stop();
  stopLumeServe(lumeHandle);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
