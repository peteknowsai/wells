import { describe, expect, test } from "bun:test";
import {
  haltGuestForSeal,
  SEAL_HALT,
  type SealHaltDeps,
} from "./sealHalt.ts";

// Fake dep builder — records calls so we can assert the escalation path.
function fakeDeps(over: Partial<SealHaltDeps> & {
  haltCode?: number;
  releasedWithin?: boolean;
}): {
  deps: SealHaltDeps;
  calls: { stopWell: number; waitForDiskReleased: number; sysrqHalt: number; fastWaitMs: number | null };
} {
  const calls = { stopWell: 0, waitForDiskReleased: 0, sysrqHalt: 0, fastWaitMs: null as number | null };
  const deps: SealHaltDeps = {
    sysrqHalt: async () => {
      calls.sysrqHalt++;
      return over.haltCode ?? 0;
    },
    diskReleasedWithin: async (_disk, ms) => {
      calls.fastWaitMs = ms;
      return over.releasedWithin ?? true;
    },
    stopWell: async () => {
      calls.stopWell++;
    },
    waitForDiskReleased: async () => {
      calls.waitForDiskReleased++;
    },
    log: { info: () => {}, warn: () => {} },
    ...over,
  };
  return { deps, calls };
}

describe("haltGuestForSeal", () => {
  test("fast path: sysrq lands (exit 0) and disk releases — no fallback", async () => {
    const { deps, calls } = fakeDeps({ haltCode: 0, releasedWithin: true });
    const res = await haltGuestForSeal(deps, "egg-x", "10.0.0.1", "/disk.img");
    expect(res.path).toBe("sysrq");
    expect(res.haltCode).toBe(0);
    expect(calls.stopWell).toBe(0);
    expect(calls.waitForDiskReleased).toBe(0);
    // The fast wait used the configured window.
    expect(calls.fastWaitMs).toBe(SEAL_HALT.FAST_WAIT_MS);
  });

  test("escalates when sysrq lands but disk stays held (own=true prod case)", async () => {
    const { deps, calls } = fakeDeps({ haltCode: 0, releasedWithin: false });
    const res = await haltGuestForSeal(deps, "egg-x", "10.0.0.1", "/disk.img");
    expect(res.path).toBe("fallback");
    expect(res.fallbackReason).toBe("disk_held");
    expect(calls.stopWell).toBe(1);
    expect(calls.waitForDiskReleased).toBe(1);
  });

  test("escalates immediately when ssh halt exits non-zero (halt never landed)", async () => {
    // releasedWithin would be true, but a non-zero halt must skip the fast
    // wait entirely and go straight to the host-controlled stop.
    const { deps, calls } = fakeDeps({ haltCode: 255, releasedWithin: true });
    const res = await haltGuestForSeal(deps, "egg-x", "10.0.0.1", "/disk.img");
    expect(res.path).toBe("fallback");
    expect(res.fallbackReason).toBe("ssh_failed");
    expect(res.haltCode).toBe(255);
    expect(calls.stopWell).toBe(1);
    expect(calls.waitForDiskReleased).toBe(1);
    // Fast wait was never consulted on the ssh-failure path.
    expect(calls.fastWaitMs).toBeNull();
  });

  test("ssh timeout (code 124) is treated as a failed halt → fallback", async () => {
    const { deps, calls } = fakeDeps({ haltCode: 124, releasedWithin: true });
    const res = await haltGuestForSeal(deps, "egg-x", "10.0.0.1", "/disk.img");
    expect(res.path).toBe("fallback");
    expect(res.fallbackReason).toBe("ssh_failed");
    expect(calls.stopWell).toBe(1);
  });

  test("propagates if even the forceful fallback never releases the disk", async () => {
    const deps: SealHaltDeps = {
      sysrqHalt: async () => 0,
      diskReleasedWithin: async () => false,
      stopWell: async () => {},
      waitForDiskReleased: async () => {
        throw new Error("disk /disk.img still held within 30000ms");
      },
      log: { info: () => {}, warn: () => {} },
    };
    await expect(
      haltGuestForSeal(deps, "egg-x", "10.0.0.1", "/disk.img"),
    ).rejects.toThrow(/still held/);
  });
});
