#!/usr/bin/env bun
// Smoke for welld's WS exec endpoint.
// Connects, sends a start frame, collects stdout/stderr/exit frames.
//
// Run:
//   WELL_API_URL=http://127.0.0.1:7878 \
//   WELL_TOKEN=$(cat ~/.wells/token) \
//   bun run scripts/smoke-ws-exec.ts <well-name> -- <cmd> [args...]

import { readToken } from "../lib/token.ts";

const args = process.argv.slice(2);
const dashIdx = args.indexOf("--");
if (dashIdx === -1 || dashIdx === 0) {
  console.error("usage: bun run scripts/smoke-ws-exec.ts <well-name> -- <cmd> [args...]");
  process.exit(64);
}
const name = args[0]!;
const cmd = args.slice(dashIdx + 1);

const baseUrl = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
const token = process.env.WELL_TOKEN ?? (await readToken());
if (!token) throw new Error("no WELL_TOKEN");

const wsUrl =
  baseUrl.replace(/^http/, "ws") +
  `/v1/wells/${encodeURIComponent(name)}/exec?token=${encodeURIComponent(token)}`;

console.error(`connecting ${wsUrl}`);
const ws = new WebSocket(wsUrl);

let stdout = "";
let stderr = "";
let exitCode: number | null = null;

const done = new Promise<void>((resolve, reject) => {
  ws.onopen = () => {
    console.error("ws open");
  };
  ws.onmessage = (ev) => {
    const frame = JSON.parse(ev.data as string);
    switch (frame.type) {
      case "ready":
        console.error("server ready, sending start");
        ws.send(JSON.stringify({ type: "start", cmd }));
        break;
      case "stdout":
        stdout += Buffer.from(frame.data, "base64").toString("utf-8");
        break;
      case "stderr":
        stderr += Buffer.from(frame.data, "base64").toString("utf-8");
        break;
      case "exit":
        exitCode = frame.code;
        break;
      case "error":
        reject(new Error(`server error: ${frame.message}`));
        break;
    }
  };
  ws.onclose = () => resolve();
  ws.onerror = (e) => reject(new Error(`ws error: ${(e as ErrorEvent).message ?? "unknown"}`));
});

try {
  await done;
} catch (e) {
  console.error(`smoke failed: ${(e as Error).message}`);
  process.exit(2);
}

console.log("--- stdout ---");
process.stdout.write(stdout);
if (stderr) {
  console.log("--- stderr ---");
  process.stdout.write(stderr);
}
console.log(`--- exit code: ${exitCode} ---`);
process.exit(exitCode ?? 1);
