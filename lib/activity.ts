// Activity probes — host-side observation of what a running splite is doing
// without reaching into the guest. The watchdog (Phase A.1.1) only knows
// about touches that hit splited's own surfaces (auth API, proxy, WS). That
// misses scenarios where the guest is busy but nothing crosses splited's
// boundary — long ssh sessions, in-guest cron, daemon background work.
//
// This module adds cheap signals the watchdog can layer on top of touches:
// active TCP connections to the splite's IP (sig-6 in docs/state-tiers.md
// and a broader sig-A "any port" variant). Probes are pure functions of
// `lsof` output — no state, no caching. The watchdog samples each tick.

import { spawn } from "bun";

export type ActivitySample = {
  // ESTABLISHED TCP connections to the VM IP, port 22 (ssh). Captures
  // an interactive ssh session, splite-exec (we ssh under the hood),
  // or anything else holding ssh open. sig-6 in the catalogue.
  sshConnections: number;
  // ESTABLISHED TCP connections to the VM IP on ANY port. Captures
  // proxied web traffic, custom service ports, in addition to ssh.
  // Differs from `sshConnections` by including non-22 ports.
  anyTcpConnections: number;
  // True if either count > 0 — the watchdog uses this as its mid-job
  // override.
  isActive: boolean;
};

export type LsofRunner = (args: string[]) => Promise<string>;

const defaultLsof: LsofRunner = async (args) => {
  // -nP avoids reverse-DNS + service-name lookups (faster, and avoids
  // hangs on slow resolvers). +c0 keeps full process names. -F (field
  // output) is more parseable than the default columnar table.
  const proc = spawn(["lsof", "-nP", "+c0", "-F", "n", ...args], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  // lsof returns 1 when no matching files — that's "zero connections", not
  // an error. Don't throw on that.
  await proc.exited;
  return out;
};

// Count ESTABLISHED TCP connections to the given VM IP, optionally filtered
// to a specific destination port. Returns 0 if lsof reports nothing.
//
// Filter shape: `-iTCP@<ip>` matches connections to/from that IP on any
// port; `-iTCP@<ip>:<port>` filters to a specific port. We additionally
// pass `-sTCP:ESTABLISHED` so half-open / TIME_WAIT entries don't count.
export async function countTcpToIp(
  ip: string,
  port: number | null = null,
  runner: LsofRunner = defaultLsof,
): Promise<number> {
  const filter = port === null ? `TCP@${ip}` : `TCP@${ip}:${port}`;
  const out = await runner(["-i", filter, "-sTCP:ESTABLISHED"]);
  // Field-output format emits one record per line; the `n` field carries
  // the connection 4-tuple. Each ESTABLISHED connection produces one
  // such line. Counting `n`-prefixed lines is reliable.
  return out.split("\n").filter((l) => l.startsWith("n")).length;
}

export async function sampleActivity(
  ip: string,
  runner: LsofRunner = defaultLsof,
): Promise<ActivitySample> {
  const [sshConnections, anyTcpConnections] = await Promise.all([
    countTcpToIp(ip, 22, runner),
    countTcpToIp(ip, null, runner),
  ]);
  return {
    sshConnections,
    anyTcpConnections,
    isActive: sshConnections > 0 || anyTcpConnections > 0,
  };
}
