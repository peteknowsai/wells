#!/usr/bin/env bun
// Forward Mac loopback ports to the wells dashboard cell. cloudflared (under launchd)
// can't reach the vmnet IP directly — macOS gates local-network access for LaunchAgents.
// Loopback is always reachable, so cloudflared connects here and we hop to the cell.

import { createServer, connect } from "node:net";

const FORWARDS = [
  { listen: 13000, target: { host: "192.168.64.206", port: 3000 } }, // Next.js
  { listen: 13210, target: { host: "192.168.64.206", port: 3210 } }, // Convex backend
];

for (const { listen, target } of FORWARDS) {
  const server = createServer((client) => {
    const upstream = connect(target.port, target.host);
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  server.listen(listen, "127.0.0.1", () => {
    console.log(`[host-forwarder] 127.0.0.1:${listen} → ${target.host}:${target.port}`);
  });
}
