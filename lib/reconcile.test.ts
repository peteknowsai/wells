import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeState, reconcileWell } from "./reconcile.ts";
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
