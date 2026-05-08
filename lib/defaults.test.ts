import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARDCODED_DEFAULTS, loadDefaults, saveDefaults } from "./defaults.ts";

describe("defaults", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-defaults-test-"));
    process.env.WELL_STATE_DIR = tmp;
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("returns hardcoded defaults when file is absent", async () => {
    expect(await loadDefaults()).toEqual(HARDCODED_DEFAULTS);
  });

  test("save + load round-trips", async () => {
    await saveDefaults({
      cpu: 8,
      memory: "8GB",
      disk: "100GB",
      auto_sleep_seconds: 300,
      checkpoint_retain_count: 10,
    });
    expect(await loadDefaults()).toEqual({
      cpu: 8,
      memory: "8GB",
      disk: "100GB",
      auto_sleep_seconds: 300,
      checkpoint_retain_count: 10,
    });
  });

  test("partial file fills in missing keys from hardcoded", async () => {
    await writeFile(join(tmp, "defaults.json"), JSON.stringify({ cpu: 2 }));
    const d = await loadDefaults();
    expect(d.cpu).toBe(2);
    expect(d.memory).toBe(HARDCODED_DEFAULTS.memory);
    expect(d.disk).toBe(HARDCODED_DEFAULTS.disk);
    expect(d.auto_sleep_seconds).toBe(HARDCODED_DEFAULTS.auto_sleep_seconds);
  });

  test("auto_sleep_seconds: null persists (never-sleep override)", async () => {
    await writeFile(
      join(tmp, "defaults.json"),
      JSON.stringify({ cpu: 4, memory: "4GB", disk: "50GB", auto_sleep_seconds: null }),
    );
    const d = await loadDefaults();
    expect(d.auto_sleep_seconds).toBeNull();
  });
});
