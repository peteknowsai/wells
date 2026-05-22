import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertHibernatable, captureXpcChildIntoRuntime } from "./lifecycle.ts";
import { PATHS } from "./state.ts";
import { defaultRuntime, readRuntime, writeRuntime } from "./wellRuntime.ts";

describe("assertHibernatable", () => {
  test("permits a healthy running VM (status + ipAddress both set)", () => {
    expect(() =>
      assertHibernatable("alpha", {
        name: "alpha",
        status: "running",
        ipAddress: "192.168.64.10",
      }),
    ).not.toThrow();
  });

  test("rejects null info (lume doesn't know the VM)", () => {
    expect(() => assertHibernatable("alpha", null)).toThrow(
      /lume has no record of 'alpha'/,
    );
  });

  test("rejects status=stopped", () => {
    expect(() =>
      assertHibernatable("alpha", { name: "alpha", status: "stopped" }),
    ).toThrow(/status='stopped'/);
  });

  test("rejects status=error", () => {
    expect(() =>
      assertHibernatable("alpha", { name: "alpha", status: "error" }),
    ).toThrow(/status='error'/);
  });

  test("rejects status=provisioning", () => {
    expect(() =>
      assertHibernatable("alpha", { name: "alpha", status: "provisioning" }),
    ).toThrow(/status='provisioning'/);
  });

  test("rejects status=running + ipAddress=null when caller didn't probe substrate", () => {
    expect(() =>
      assertHibernatable("alpha", {
        name: "alpha",
        status: "running",
        ipAddress: null,
      }),
    ).toThrow(/did not provide substrate confirmation/);
  });

  test("rejects status=running + ipAddress missing when caller didn't probe substrate", () => {
    expect(() =>
      assertHibernatable("alpha", { name: "alpha", status: "running" }),
    ).toThrow(/did not provide substrate confirmation/);
  });

  test("rejects status=running + ipAddress=null when substrate probe says dead", () => {
    expect(() =>
      assertHibernatable(
        "alpha",
        { name: "alpha", status: "running", ipAddress: null },
        false,
      ),
    ).toThrow(/substrate probe \(lease file \+ TCP\) failed/);
  });

  test("permits status=running + ipAddress=null when substrate probe says alive (fresh-boot lag)", () => {
    expect(() =>
      assertHibernatable(
        "alpha",
        { name: "alpha", status: "running", ipAddress: null },
        true,
      ),
    ).not.toThrow();
  });

  test("substrateAlive=true is irrelevant when status != running", () => {
    expect(() =>
      assertHibernatable(
        "alpha",
        { name: "alpha", status: "stopped" },
        true,
      ),
    ).toThrow(/status='stopped'/);
  });

  test("error message for status mismatch points toward FSM reconciliation", () => {
    let msg = "";
    try {
      assertHibernatable("alpha", { name: "alpha", status: "error" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("reconcile FSM");
  });

  test("error message for substrate-confirmed-dead calls out the lume crash hazard", () => {
    let msg = "";
    try {
      assertHibernatable(
        "alpha",
        { name: "alpha", status: "running", ipAddress: null },
        false,
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("crashed lume serve");
  });
});

describe("captureXpcChildIntoRuntime — start persists alive_running", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-capture-test-"));
    process.env.WELL_STATE_DIR = tmp;
    await mkdir(PATHS.vmDir("pete"), { recursive: true });
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("a start from a stale `stopped` record advances state to alive_running", async () => {
    // The desync trap (docs/findings-welld-state-desync.md): startWell
    // boots the VM but used to leave the record untouched. Verify the
    // capture step now carries the record forward.
    await writeRuntime("pete", {
      ...defaultRuntime(),
      state: "stopped",
      last_transition_at: "2026-05-20T00:22:18.492Z",
      last_error: "stale",
    });
    await captureXpcChildIntoRuntime("pete", [], { xpcTimeoutMs: 50 });
    const after = await readRuntime("pete");
    expect(after?.state).toBe("alive_running");
    expect(after?.last_error).toBeNull();
    expect(after?.last_transition_at).not.toBe("2026-05-20T00:22:18.492Z");
  });

  test("an already-running record keeps its transition timestamp (no churn)", async () => {
    const original = defaultRuntime();
    await writeRuntime("pete", original);
    await captureXpcChildIntoRuntime("pete", [], { xpcTimeoutMs: 50 });
    const after = await readRuntime("pete");
    expect(after?.state).toBe("alive_running");
    expect(after?.last_transition_at).toBe(original.last_transition_at);
  });

  test("no runtime file → no fabricated record (create-path transient)", async () => {
    await captureXpcChildIntoRuntime("pete", [], { xpcTimeoutMs: 50 });
    expect(await readRuntime("pete")).toBeNull();
  });
});
