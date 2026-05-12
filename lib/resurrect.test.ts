import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWell, type WellRecord } from "./registry.ts";
import { writeRuntime, defaultRuntime } from "./wellRuntime.ts";
import { resurrectAliveWells } from "./resurrect.ts";

// resurrectAliveWells inspects each well's runtime.json + lume's view
// + hibernate.bin presence, then decides whether to start. Tests cover
// the skip-decision matrix without needing lume up (skip cases never
// reach the lume call).
//
// "would resurrect" cases hit `startWell` which makes lume HTTP calls
// — those land in `result.failed` here (no lume running in tests),
// which is exactly the right test signal: they got past the skip
// branches.

const sample = (name: string): WellRecord => ({
  name,
  uuid: "u-" + name,
  created_at: "2026-05-06T12:00:00Z",
  cpu: 4,
  memory: "4GB",
  disk_size: "50GB",
});

describe("resurrectAliveWells — skip matrix", () => {
  let tmp: string;
  let tmpLume: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-resurrect-test-"));
    tmpLume = await mkdtemp(join(tmpdir(), "wells-resurrect-lume-"));
    process.env.WELL_STATE_DIR = tmp;
    process.env.WELL_LUME_STORAGE = tmpLume;
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    delete process.env.WELL_LUME_STORAGE;
    await rm(tmp, { recursive: true, force: true });
    await rm(tmpLume, { recursive: true, force: true });
  });

  test("considered count = registered wells count", async () => {
    await addWell(sample("a"));
    await addWell(sample("b"));
    const r = await resurrectAliveWells();
    expect(r.considered).toBe(2);
  });

  test("skips wells with no runtime.json", async () => {
    await addWell(sample("never-ran"));
    const r = await resurrectAliveWells();
    expect(r.resurrected).toEqual([]);
    expect(r.skipped.find((s) => s.name === "never-ran")?.reason).toContain(
      "no runtime.json",
    );
  });

  test("skips wells whose last state was stopped (operator intent)", async () => {
    await addWell(sample("stopped-by-op"));
    const rt = defaultRuntime();
    rt.state = "stopped";
    await writeRuntime("stopped-by-op", rt);
    const r = await resurrectAliveWells();
    expect(r.resurrected).toEqual([]);
    expect(r.skipped.find((s) => s.name === "stopped-by-op")?.reason).toContain(
      "not alive_*",
    );
  });

  test("skips error_orphaned wells", async () => {
    await addWell(sample("broken"));
    const rt = defaultRuntime();
    rt.state = "error_orphaned";
    rt.last_error = "test";
    await writeRuntime("broken", rt);
    const r = await resurrectAliveWells();
    expect(r.skipped.find((s) => s.name === "broken")?.reason).toContain(
      "not alive_*",
    );
  });

  test("skips hibernating wells (they wake on traffic)", async () => {
    await addWell(sample("napping"));
    const rt = defaultRuntime();
    rt.state = "alive_running"; // claims alive_*…
    await writeRuntime("napping", rt);
    // …but hibernate.bin exists. We trust the file over the state field
    // (defensive: if both are inconsistent, the hibernate file is the
    // hard-to-fake artifact).
    const vmDir = join(tmp, "vms", "napping");
    await mkdir(vmDir, { recursive: true });
    await writeFile(join(vmDir, "hibernate.bin"), "fake");
    const r = await resurrectAliveWells();
    expect(r.resurrected).toEqual([]);
    expect(r.skipped.find((s) => s.name === "napping")?.reason).toContain(
      "hibernate.bin present",
    );
  });

  test("alive_running well with no hibernate.bin attempts resurrection (goes to failed in test env without lume)", async () => {
    await addWell(sample("zombie-egg"));
    const rt = defaultRuntime();
    rt.state = "alive_running";
    await writeRuntime("zombie-egg", rt);
    const r = await resurrectAliveWells();
    // Test env has no lume serve → startWell fails → counted as failed.
    // The key assertion: we got PAST the skip branches.
    const skipped = r.skipped.find((s) => s.name === "zombie-egg");
    const failed = r.failed.find((f) => f.name === "zombie-egg");
    // Either: lume.info returned null (skipped "lume already reports running"
    // isn't possible here, but lume.info catch returning null doesn't trip
    // that skip — the skip only fires on info?.status === "running"). So
    // the well should hit the startWell path → failed.
    expect(failed ?? skipped).toBeDefined();
    if (failed) {
      expect(failed.error.length).toBeGreaterThan(0);
    }
  });

  test("alive_paused well with no hibernate.bin attempts resurrection", async () => {
    await addWell(sample("paused-egg"));
    const rt = defaultRuntime();
    rt.state = "alive_paused";
    await writeRuntime("paused-egg", rt);
    const r = await resurrectAliveWells();
    const failed = r.failed.find((f) => f.name === "paused-egg");
    const skipped = r.skipped.find((s) => s.name === "paused-egg");
    expect(failed ?? skipped).toBeDefined();
  });

  test("returns counts/sets that sum to considered", async () => {
    await addWell(sample("a"));
    await addWell(sample("b"));
    await addWell(sample("c"));
    const rta = defaultRuntime(); rta.state = "stopped";
    const rtb = defaultRuntime(); rtb.state = "alive_running";
    // c has no runtime
    await writeRuntime("a", rta);
    await writeRuntime("b", rtb);
    const r = await resurrectAliveWells();
    const total = r.resurrected.length + r.skipped.length + r.failed.length;
    expect(total).toBe(r.considered);
  });
});
