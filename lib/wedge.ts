// Wedge detection for wells whose network has gone unresponsive at the
// data layer while TCP handshakes still succeed (the "banner-hang"
// pattern seen 2026-05-15 twice). pkill / cold-cycle clears it but root
// cause is unknown — this module's job is to detect, log loudly, and
// capture diagnostics so the next occurrence is investigable.
//
// Pure dispatch — IO is injected for unit-testability.

import { connect } from "node:net";

export interface WedgeProbeResult {
  ok: boolean;
  // Reason banner-read failed when !ok. Lets diagnostics describe what
  // shape of failure we saw (handshake refused vs banner-timeout vs etc).
  reason?: "no-ip" | "connect-refused" | "connect-timeout" | "banner-timeout" | "banner-empty";
}

// Probe the well's SSH port for a banner. TCP handshake alone returns
// "open" even when the well is wedged — only a successful banner read
// (data actually flowing) proves the network path is healthy. 5s is
// chosen to be longer than typical sshd response time (<100ms) but
// shorter than the watchdog tick (30s) so we don't pile up probes.
export async function probeSshBanner(
  ip: string,
  port: number = 22,
  timeoutMs: number = 5_000,
): Promise<WedgeProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: WedgeProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const sock = connect({ host: ip, port, allowHalfOpen: false });
    const timer = setTimeout(() => {
      sock.destroy();
      // If we already TCP-connected but no data, that's the wedge signature.
      // If we never connected, the timer fires first as a connect-timeout.
      settle({ ok: false, reason: sock.connecting ? "connect-timeout" : "banner-timeout" });
    }, timeoutMs);

    sock.on("data", (chunk) => {
      clearTimeout(timer);
      sock.destroy();
      const s = chunk.toString("ascii");
      // sshd banner is "SSH-2.0-OpenSSH_..."; any non-empty data from
      // port 22 proves the service is responding.
      if (s.length > 0) settle({ ok: true });
      else settle({ ok: false, reason: "banner-empty" });
    });

    sock.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      sock.destroy();
      if (err.code === "ECONNREFUSED") settle({ ok: false, reason: "connect-refused" });
      else settle({ ok: false, reason: "connect-timeout" });
    });
  });
}

// State machine for wedge confirmation. Tracks consecutive probe
// failures per well; emits "wedge_confirmed" exactly once when the
// threshold is crossed, "wedge_cleared" exactly once when it resets.
// Pure — no IO, no Date.now() reads.

export interface WedgeState {
  // consecutive failures since the last success (or since first probe)
  failures: number;
  // whether we've already emitted "wedge_confirmed" for this run
  alerted: boolean;
}

export interface WedgeTransition {
  // null means no transition this tick
  emit: "wedge_suspected" | "wedge_confirmed" | "wedge_cleared" | null;
}

export const WEDGE_SUSPECT_THRESHOLD = 3; // 3 ticks × 30s = 1.5 min
export const WEDGE_CONFIRM_THRESHOLD = 6; // 6 ticks × 30s = 3 min

export function stepWedgeState(
  prev: WedgeState | undefined,
  probeOk: boolean,
): { next: WedgeState; transition: WedgeTransition } {
  const cur = prev ?? { failures: 0, alerted: false };
  if (probeOk) {
    if (cur.alerted) {
      // Transitioning from alerted back to healthy.
      return {
        next: { failures: 0, alerted: false },
        transition: { emit: "wedge_cleared" },
      };
    }
    return { next: { failures: 0, alerted: false }, transition: { emit: null } };
  }
  // Failure.
  const failures = cur.failures + 1;
  if (!cur.alerted && failures >= WEDGE_CONFIRM_THRESHOLD) {
    return {
      next: { failures, alerted: true },
      transition: { emit: "wedge_confirmed" },
    };
  }
  if (!cur.alerted && failures === WEDGE_SUSPECT_THRESHOLD) {
    return {
      next: { failures, alerted: false },
      transition: { emit: "wedge_suspected" },
    };
  }
  return { next: { failures, alerted: cur.alerted }, transition: { emit: null } };
}
