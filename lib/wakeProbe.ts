// TCP reachability probe for the wake post-condition.
//
// Cells team's ask (2026-05-22): `/wake` shouldn't return 200 until the
// guest is actually answering. Before this, `/wake` returned as soon as
// `transitionWell("wake")` or `resumeWell()` resolved — which is BEFORE
// the kernel has re-attached virtio-net, restored routing, and let sshd
// accept connections. Callers (cells) ended up inventing their own SSH
// probe to bridge the gap. That's a leaky contract: wells owns the wake
// lifecycle, so wells should own "is it reachable yet."
//
// Probe shape: TCP connect to port 22 with a short per-attempt timeout,
// retry every ~150ms until the connect succeeds (we get SYN-ACK) or the
// deadline expires. Stronger than ICMP — proves sshd is bound, not just
// that the IP routes. Lighter than `waitForSshReady` — no auth, no key,
// no /etc/.well-ready check (those are first-boot concerns; wake is a
// resume, the marker file is already there).
//
// On timeout we throw — wake handler should surface 504 to the caller
// and leave the well running. Caller retries; we don't auto-hibernate.
//
// 10s default matches cells's suggestion. Local vmnet wake-from-restore
// in our measurements lands well under 1s, so 10s is comfortable head-
// room for cold-cache or contended-host edge cases.

import { connect } from "node:net";

export interface WaitForTcpReachableOpts {
  ip: string;
  port?: number;
  deadlineMs?: number;
  attemptTimeoutMs?: number;
  intervalMs?: number;
}

export async function waitForTcpReachable(opts: WaitForTcpReachableOpts): Promise<void> {
  const port = opts.port ?? 22;
  const deadline = Date.now() + (opts.deadlineMs ?? 10_000);
  const attemptTimeout = opts.attemptTimeoutMs ?? 1_000;
  const interval = opts.intervalMs ?? 150;

  let lastErr: string = "no attempts";
  while (Date.now() < deadline) {
    try {
      await tryConnect(opts.ip, port, attemptTimeout);
      return;
    } catch (err) {
      lastErr = (err as Error).message;
    }
    if (Date.now() >= deadline) break;
    await Bun.sleep(interval);
  }
  throw new Error(
    `tcp ${opts.ip}:${port} not reachable within ${opts.deadlineMs ?? 10_000}ms (last: ${lastErr})`,
  );
}

function tryConnect(ip: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: ip, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`connect timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.end();
      resolve();
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    });
  });
}
