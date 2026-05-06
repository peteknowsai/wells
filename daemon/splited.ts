#!/usr/bin/env bun
// splited — the splites daemon. HTTP on :7878. Sprites-shaped REST.
// Phase 0: just /healthz. Real endpoints land in phase 8.

const PORT = Number(process.env.SPLITES_PORT ?? 7878);
const VERSION = "0.1.0-pre";

const startedAt = new Date().toISOString();

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
      });
    }
    return new Response("not found\n", { status: 404 });
  },
});

console.error(`splited listening on http://${server.hostname}:${server.port}`);

const shutdown = () => {
  console.error("splited shutting down");
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
