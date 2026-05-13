import { describe, expect, test } from "bun:test";
import { handleSeal, type SealingDeps, type SealResultShape } from "./sealing.ts";

function makeDeps(over: Partial<SealingDeps> = {}): SealingDeps {
  return {
    findWell: async (n) => ({ name: n }),
    sealWell: async () => ({
      sealed_at: "2026-05-13T20:00:00Z",
      elapsed_ms: 8500,
      ip: "192.168.64.42",
    }),
    ...over,
  };
}

class FakeSealError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

describe("handleSeal", () => {
  test("404 when findWell returns null", async () => {
    const res = await handleSeal("ghost", makeDeps({ findWell: async () => null }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  test("200 on success — returns sealed_at + elapsed_ms + ip", async () => {
    const res = await handleSeal("alice", makeDeps());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      name: "alice",
      sealed_at: "2026-05-13T20:00:00Z",
      elapsed_ms: 8500,
      ip: "192.168.64.42",
    });
  });

  test("409 well_already_sealed when SealError code matches", async () => {
    const res = await handleSeal(
      "alice",
      makeDeps({
        sealWell: async () => {
          throw new FakeSealError(
            "well_already_sealed",
            "well 'alice' is already sealed (hibernate_ready=true)",
          );
        },
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("well_already_sealed");
    expect(body.message).toContain("already sealed");
  });

  test("409 well_not_running when SealError code matches", async () => {
    const res = await handleSeal(
      "alice",
      makeDeps({
        sealWell: async () => {
          throw new FakeSealError(
            "well_not_running",
            "well 'alice' status='stopped' — must be running to seal",
          );
        },
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("well_not_running");
  });

  test("500 seal_failed on plain Error (lume/SSH/disk-release failures)", async () => {
    const res = await handleSeal(
      "alice",
      makeDeps({
        sealWell: async () => {
          throw new Error("waitForDiskReleased: timeout after 60000ms");
        },
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("seal_failed");
    expect(body.message).toContain("waitForDiskReleased");
  });
});
