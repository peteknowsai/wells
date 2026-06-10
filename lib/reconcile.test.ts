import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isStaleDownRecord,
  observeState,
  reconcileWell,
  repairStaleDownRecords,
} from "./reconcile.ts";
import { PATHS } from "./state.ts";
import { readRuntime, writeRuntime, defaultRuntime } from "./wellRuntime.ts";

describe("observeState — derivation matrix", () => {
  test("bundle missing → missing (overrides everything)", () => {
    expect(
      observeState({
        bundleMissing: true,
        lumeStatus: "running",
        paused: true,
        hibernateFileExists: true,
        xpcChildAlive: true,
      }),
    ).toBe("missing");
  });

  test("hibernate file + no XPC child → hibernating", () => {
    expect(
      observeState({
        bundleMissing: false,
        lumeStatus: "stopped",
        paused: false,
        hibernateFileExists: true,
        xpcChildAlive: false,
      }),
    ).toBe("hibernating");
  });

  test("hibernate file + XPC alive → error_orphaned", () => {
    // A VZ child is alive but we have a hibernate file — the previous
    // hibernate didn't fully tear down. Operator inspection.
    expect(
      observeState({
        bundleMissing: false,
        lumeStatus: "stopped",
        paused: false,
        hibernateFileExists: true,
        xpcChildAlive: true,
      }),
    ).toBe("error_orphaned");
  });

  test("lume running + paused → alive_paused", () => {
    expect(
      observeState({
        bundleMissing: false,
        lumeStatus: "running",
        paused: true,
        hibernateFileExists: false,
        xpcChildAlive: true,
      }),
    ).toBe("alive_paused");
  });

  test("lume running + not paused → alive_running", () => {
    expect(
      observeState({
        bundleMissing: false,
        lumeStatus: "running",
        paused: false,
        hibernateFileExists: false,
        xpcChildAlive: true,
      }),
    ).toBe("alive_running");
  });

  test("lume stopped + no XPC + no hibernate → stopped", () => {
    expect(
      observeState({
        bundleMissing: false,
        lumeStatus: "stopped",
        paused: false,
        hibernateFileExists: false,
        xpcChildAlive: false,
      }),
    ).toBe("stopped");
  });

  test("lume stopped + XPC alive (no hibernate) → error_orphaned", () => {
    // Classic orphan: lume crashed + respawned, lost its SharedVM
    // cache, but the VZ XPC child kept running detached.
    expect(
      observeState({
        bundleMissing: false,
        lumeStatus: "stopped",
        paused: false,
        hibernateFileExists: false,
        xpcChildAlive: true,
      }),
    ).toBe("error_orphaned");
  });

  test("lume null (unknown) + XPC alive → error_orphaned", () => {
    expect(
      observeState({
        bundleMissing: false,
        lumeStatus: null,
        paused: false,
        hibernateFileExists: false,
        xpcChildAlive: true,
      }),
    ).toBe("error_orphaned");
  });

  test("lume null + nothing else → stopped (registered but quiet)", () => {
    expect(
      observeState({
        bundleMissing: false,
        lumeStatus: null,
        paused: false,
        hibernateFileExists: false,
        xpcChildAlive: false,
      }),
    ).toBe("stopped");
  });
});

describe("reconcileWell — IO + persistence", () => {
  let tmp: string;
  let vmDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-reconcile-test-"));
    process.env.WELL_STATE_DIR = tmp;
    vmDir = PATHS.vmDir("pete");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(vmDir, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("reconcile from no-runtime defaults to alive_running, then converges", async () => {
    // Bundle exists, lume reports stopped, no hibernate, no XPC.
    // Expected observed state: stopped. Default runtime starts as
    // alive_running so we should see a transition.
    const after = await reconcileWell("pete", {
      lumeStatus: async () => "stopped",
      isPaused: () => false,
      bundleMissing: () => false,
      xpcChildAlive: () => false,
    });
    expect(after.state).toBe("stopped");
    // Persisted on disk too.
    const fromDisk = await readRuntime("pete");
    expect(fromDisk?.state).toBe("stopped");
  });

  test("no-op reconcile leaves runtime untouched (no transition timestamp bump)", async () => {
    const original = defaultRuntime();
    await writeRuntime("pete", original);
    const after = await reconcileWell("pete", {
      lumeStatus: async () => "running",
      isPaused: () => false,
      bundleMissing: () => false,
      xpcChildAlive: () => true,
    });
    expect(after.state).toBe("alive_running");
    expect(after.last_transition_at).toBe(original.last_transition_at);
  });

  test("orphan detection: lume stopped but XPC alive → error_orphaned + last_error", async () => {
    await writeRuntime("pete", defaultRuntime());
    const after = await reconcileWell("pete", {
      lumeStatus: async () => "stopped",
      isPaused: () => false,
      bundleMissing: () => false,
      xpcChildAlive: () => true,
    });
    expect(after.state).toBe("error_orphaned");
    expect(after.last_error).toBeTruthy();
    expect(after.last_error).toContain("xpc=true");
  });

  test("hibernate file with no XPC reconciles to hibernating", async () => {
    await writeRuntime("pete", defaultRuntime());
    // Drop the hibernate.bin so existsSync sees it.
    await writeFile(PATHS.vmHibernate("pete"), "fake-state-data");
    const after = await reconcileWell("pete", {
      lumeStatus: async () => "stopped",
      isPaused: () => false,
      bundleMissing: () => false,
      xpcChildAlive: () => false,
    });
    expect(after.state).toBe("hibernating");
  });

  test("paused well stays paused even though lume reports running", async () => {
    await writeRuntime("pete", defaultRuntime());
    const after = await reconcileWell("pete", {
      lumeStatus: async () => "running",
      isPaused: () => true,
      bundleMissing: () => false,
      xpcChildAlive: () => true,
    });
    expect(after.state).toBe("alive_paused");
  });
});

describe("isStaleDownRecord — the welld desync trap", () => {
  test("stopped record + lume running + no hibernate file → stale", () => {
    expect(isStaleDownRecord("stopped", true, false)).toBe(true);
  });

  test("hibernating record + lume running + no hibernate file → stale", () => {
    // runtime.json says hibernating but lume runs the VM and no
    // hibernate.bin exists — the record is a lie, repair it.
    expect(isStaleDownRecord("hibernating", true, false)).toBe(true);
  });

  test("stopped record + lume NOT running → not stale (genuinely down)", () => {
    expect(isStaleDownRecord("stopped", false, false)).toBe(false);
  });

  test("stopped record + lume running + hibernate file present → not stale (orphan)", () => {
    // A hibernate.bin alongside a live VM is error_orphaned territory,
    // not this trap — repairing to alive_running would mask a failed
    // teardown.
    expect(isStaleDownRecord("stopped", true, true)).toBe(false);
  });

  test("alive_running record → never stale (already correct)", () => {
    expect(isStaleDownRecord("alive_running", true, false)).toBe(false);
  });

  test("alive_paused record → not stale (reconcile's ambiguous case, not this one)", () => {
    expect(isStaleDownRecord("alive_paused", true, false)).toBe(false);
  });

  test("error_orphaned record → not stale (operator must clear it)", () => {
    expect(isStaleDownRecord("error_orphaned", true, false)).toBe(false);
  });
});

describe("repairStaleDownRecords — watchdog record repair", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-repair-test-"));
    process.env.WELL_STATE_DIR = tmp;
    const { mkdir } = await import("node:fs/promises");
    for (const n of ["egg-a", "egg-b", "egg-c"]) {
      await mkdir(PATHS.vmDir(n), { recursive: true });
    }
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("repairs a stale stopped record to alive_running and persists it", async () => {
    await writeRuntime("egg-a", {
      ...defaultRuntime(),
      state: "stopped",
      last_transition_at: "2026-05-20T00:22:18.492Z",
    });
    const repaired = await repairStaleDownRecords({
      names: ["egg-a"],
      lumeGenuinelyRunning: () => true,
    });
    expect(repaired).toEqual([{ name: "egg-a", from: "stopped" }]);
    const fromDisk = await readRuntime("egg-a");
    expect(fromDisk?.state).toBe("alive_running");
    // Stale frozen timestamp gets refreshed by the repair.
    expect(fromDisk?.last_transition_at).not.toBe("2026-05-20T00:22:18.492Z");
  });

  test("skips wells with an in-flight transition (lock held)", async () => {
    // The 2026-06-10 live-fire shape: zombie recovery (holding the
    // well lock) wrote stopped and was mid-startWell when this pass
    // flipped the record back to alive_running. With isLocked wired,
    // the locked well is left alone; the unlocked one still repairs.
    await writeRuntime("egg-a", { ...defaultRuntime(), state: "stopped" });
    await writeRuntime("egg-b", { ...defaultRuntime(), state: "stopped" });
    const repaired = await repairStaleDownRecords({
      names: ["egg-a", "egg-b"],
      lumeGenuinelyRunning: () => true,
      isLocked: (n) => n === "egg-a",
    });
    expect(repaired).toEqual([{ name: "egg-b", from: "stopped" }]);
    expect((await readRuntime("egg-a"))?.state).toBe("stopped");
    expect((await readRuntime("egg-b"))?.state).toBe("alive_running");
  });

  test("leaves a genuinely stopped well (lume not running) untouched", async () => {
    await writeRuntime("egg-a", { ...defaultRuntime(), state: "stopped" });
    const repaired = await repairStaleDownRecords({
      names: ["egg-a"],
      lumeGenuinelyRunning: () => false,
    });
    expect(repaired).toEqual([]);
    expect((await readRuntime("egg-a"))?.state).toBe("stopped");
  });

  test("leaves an already-correct alive_running record untouched", async () => {
    await writeRuntime("egg-a", defaultRuntime());
    const repaired = await repairStaleDownRecords({
      names: ["egg-a"],
      lumeGenuinelyRunning: () => true,
    });
    expect(repaired).toEqual([]);
  });

  test("skips wells with no runtime file", async () => {
    const repaired = await repairStaleDownRecords({
      names: ["egg-a"],
      lumeGenuinelyRunning: () => true,
    });
    expect(repaired).toEqual([]);
  });

  test("repairs only the stale wells in a mixed batch", async () => {
    await writeRuntime("egg-a", { ...defaultRuntime(), state: "stopped" });
    await writeRuntime("egg-b", defaultRuntime());
    await writeRuntime("egg-c", { ...defaultRuntime(), state: "hibernating" });
    const repaired = await repairStaleDownRecords({
      names: ["egg-a", "egg-b", "egg-c"],
      // egg-a and egg-b run; egg-c is genuinely hibernating (lume down).
      lumeGenuinelyRunning: (n) => n === "egg-a" || n === "egg-b",
    });
    expect(repaired.map((r) => r.name).sort()).toEqual(["egg-a"]);
    expect((await readRuntime("egg-c"))?.state).toBe("hibernating");
  });
});
