import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import {
  probeSshBanner,
  stepWedgeState,
  wedgeLabel,
  WEDGE_SUSPECT_THRESHOLD,
  WEDGE_CONFIRM_THRESHOLD,
} from "./wedge.ts";

describe("stepWedgeState", () => {
  test("first probe ok → no transition", () => {
    const r = stepWedgeState(undefined, true);
    expect(r.transition.emit).toBeNull();
    expect(r.next).toEqual({ failures: 0, alerted: false });
  });

  test("ok after ok → still no transition", () => {
    const after1 = stepWedgeState(undefined, true).next;
    const r = stepWedgeState(after1, true);
    expect(r.transition.emit).toBeNull();
  });

  test("crosses suspect threshold → emits wedge_suspected once", () => {
    let state = undefined;
    for (let i = 1; i < WEDGE_SUSPECT_THRESHOLD; i++) {
      state = stepWedgeState(state, false).next;
    }
    const r = stepWedgeState(state, false);
    expect(r.transition.emit).toBe("wedge_suspected");
    expect(r.next.failures).toBe(WEDGE_SUSPECT_THRESHOLD);
    expect(r.next.alerted).toBe(false);
  });

  test("crosses confirm threshold → emits wedge_confirmed once", () => {
    let state = undefined;
    for (let i = 1; i < WEDGE_CONFIRM_THRESHOLD; i++) {
      state = stepWedgeState(state, false).next;
    }
    const r = stepWedgeState(state, false);
    expect(r.transition.emit).toBe("wedge_confirmed");
    expect(r.next.alerted).toBe(true);
  });

  test("after confirm, further failures don't re-emit", () => {
    let state = { failures: WEDGE_CONFIRM_THRESHOLD, alerted: true };
    for (let i = 0; i < 5; i++) {
      const r = stepWedgeState(state, false);
      expect(r.transition.emit).toBeNull();
      state = r.next;
    }
  });

  test("recovery emits wedge_cleared once, then quiet", () => {
    const confirmed = { failures: WEDGE_CONFIRM_THRESHOLD, alerted: true };
    const r1 = stepWedgeState(confirmed, true);
    expect(r1.transition.emit).toBe("wedge_cleared");
    expect(r1.next).toEqual({ failures: 0, alerted: false });
    const r2 = stepWedgeState(r1.next, true);
    expect(r2.transition.emit).toBeNull();
  });

  test("recovery before confirm → silent reset (no wedge_cleared)", () => {
    const partial = { failures: WEDGE_SUSPECT_THRESHOLD, alerted: false };
    const r = stepWedgeState(partial, true);
    expect(r.transition.emit).toBeNull();
    expect(r.next).toEqual({ failures: 0, alerted: false });
  });
});

describe("probeSshBanner", () => {
  function startBannerServer(banner: string | null, delayMs: number = 0): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer((sock) => {
        if (banner === null) return; // accept + hang forever (wedge simulation)
        setTimeout(() => {
          sock.write(banner);
        }, delayMs);
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({ server, port });
      });
    });
  }

  test("ok when server sends an SSH banner promptly", async () => {
    const { server, port } = await startBannerServer("SSH-2.0-OpenSSH_9.6\r\n");
    const r = await probeSshBanner("127.0.0.1", port, 2_000);
    server.close();
    expect(r.ok).toBe(true);
  });

  test("banner-timeout when server accepts TCP but never sends data (wedge shape)", async () => {
    const { server, port } = await startBannerServer(null);
    const r = await probeSshBanner("127.0.0.1", port, 500);
    server.close();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("banner-timeout");
  });

  test("connect-refused when nothing listens", async () => {
    // Pick a port we're confident is unused. Try port 1 (privileged, unbindable).
    const r = await probeSshBanner("127.0.0.1", 1, 500);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/connect-refused|connect-timeout/);
  });
});

describe("wedgeLabel", () => {
  test("undefined → 'ok' (no probe state yet)", () => {
    expect(wedgeLabel(undefined)).toBe("ok");
  });

  test("zero failures → 'ok'", () => {
    expect(wedgeLabel({ failures: 0, alerted: false })).toBe("ok");
  });

  test("below suspect threshold → 'ok'", () => {
    expect(wedgeLabel({ failures: WEDGE_SUSPECT_THRESHOLD - 1, alerted: false })).toBe("ok");
  });

  test("at suspect threshold but not alerted → 'suspected'", () => {
    expect(wedgeLabel({ failures: WEDGE_SUSPECT_THRESHOLD, alerted: false })).toBe("suspected");
  });

  test("between thresholds → 'suspected'", () => {
    expect(wedgeLabel({ failures: WEDGE_CONFIRM_THRESHOLD - 1, alerted: false })).toBe("suspected");
  });

  test("alerted → 'confirmed' regardless of failure count", () => {
    expect(wedgeLabel({ failures: WEDGE_CONFIRM_THRESHOLD, alerted: true })).toBe("confirmed");
    expect(wedgeLabel({ failures: 100, alerted: true })).toBe("confirmed");
  });
});
