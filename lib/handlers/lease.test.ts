import { describe, expect, test } from "bun:test";
import {
  handleReleaseLease,
  handleFlushLeases,
  type ReleaseLeaseDeps,
  type FlushLeasesDeps,
  type HelperResult,
} from "./lease.ts";

describe("handleReleaseLease", () => {
  test("ok → 200 with released field", async () => {
    const deps: ReleaseLeaseDeps = {
      releaseLease: async () => ({ ok: true }),
    };
    const res = await handleReleaseLease("pete", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; released: string };
    expect(body.released).toBe("pete");
  });

  test("invalid-arg → 400 bad_request", async () => {
    const deps: ReleaseLeaseDeps = {
      releaseLease: async () => ({ ok: false, reason: "invalid-arg" }),
    };
    const res = await handleReleaseLease("bad name!", deps);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("not-installed → 503 helper_not_installed", async () => {
    const deps: ReleaseLeaseDeps = {
      releaseLease: async () => ({ ok: false, reason: "not-installed" }),
    };
    const res = await handleReleaseLease("pete", deps);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("helper_not_installed");
  });

  test("exit-nonzero → 500 helper_failed with exit code + stderr", async () => {
    const deps: ReleaseLeaseDeps = {
      releaseLease: async (): Promise<HelperResult> => ({
        ok: false,
        reason: "exit-nonzero",
        exitCode: 2,
        stderr: "lease not found",
      }),
    };
    const res = await handleReleaseLease("pete", deps);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("helper_failed");
    expect(body.message).toContain("exit=2");
    expect(body.message).toContain("lease not found");
  });
});

describe("handleFlushLeases", () => {
  test("no orphans → 200 with empty arrays", async () => {
    const deps: FlushLeasesDeps = {
      computeOrphanLeases: async () => [],
      releaseLease: async () => ({ ok: true }),
    };
    const res = await handleFlushLeases(deps);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      released: string[];
      released_count: number;
      orphan_count: number;
    };
    expect(body.released).toEqual([]);
    expect(body.released_count).toBe(0);
    expect(body.orphan_count).toBe(0);
  });

  test("all orphans released → 200, released list populated", async () => {
    const deps: FlushLeasesDeps = {
      computeOrphanLeases: async () => [{ name: "a" }, { name: "b" }],
      releaseLease: async () => ({ ok: true }),
    };
    const res = await handleFlushLeases(deps);
    const body = await res.json() as {
      released: string[];
      failed: unknown[];
    };
    expect(body.released).toEqual(["a", "b"]);
    expect(body.failed).toEqual([]);
  });

  test("name === null entries are skipped (not counted as failed)", async () => {
    const deps: FlushLeasesDeps = {
      computeOrphanLeases: async () => [
        { name: null },
        { name: "real" },
      ],
      releaseLease: async () => ({ ok: true }),
    };
    const res = await handleFlushLeases(deps);
    const body = await res.json() as {
      released: string[];
      orphan_count: number;
    };
    expect(body.released).toEqual(["real"]);
    expect(body.orphan_count).toBe(2);
  });

  test("partial failure: non-ok results land in failed[], others in released[]", async () => {
    let n = 0;
    const deps: FlushLeasesDeps = {
      computeOrphanLeases: async () => [{ name: "a" }, { name: "b" }, { name: "c" }],
      releaseLease: async (hn) => {
        n++;
        if (hn === "b") return { ok: false, reason: "exit-nonzero", exitCode: 1 };
        return { ok: true };
      },
    };
    const res = await handleFlushLeases(deps);
    expect(n).toBe(3);
    const body = await res.json() as {
      released: string[];
      failed: Array<{ name: string; reason: string; code?: number }>;
    };
    expect(body.released).toEqual(["a", "c"]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].name).toBe("b");
    expect(body.failed[0].code).toBe(1);
  });

  test("not-installed mid-flush → abort early with 503", async () => {
    const deps: FlushLeasesDeps = {
      computeOrphanLeases: async () => [{ name: "a" }, { name: "b" }],
      releaseLease: async (hn) => {
        if (hn === "a") return { ok: true };
        return { ok: false, reason: "not-installed" };
      },
    };
    const res = await handleFlushLeases(deps);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("helper_not_installed");
  });
});
