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
      pool_size: 2,
      static_ip_range: "210-220",
    });
    expect(await loadDefaults()).toEqual({
      cpu: 8,
      memory: "8GB",
      disk: "100GB",
      auto_sleep_seconds: 300,
      checkpoint_retain_count: 10,
      pool_size: 2,
      static_ip_range: "210-220",
    });
  });

  test("static_ip_range: null persists (disable static allocation)", async () => {
    await writeFile(
      join(tmp, "defaults.json"),
      JSON.stringify({ cpu: 4, memory: "4GB", disk: "50GB", static_ip_range: null }),
    );
    const d = await loadDefaults();
    expect(d.static_ip_range).toBeNull();
  });

  test("static_ip_range: defaults to hardcoded 200-250 when omitted", async () => {
    await writeFile(join(tmp, "defaults.json"), JSON.stringify({ cpu: 2 }));
    const d = await loadDefaults();
    expect(d.static_ip_range).toBe("200-250");
  });

  test("static_ip_range: null in file disables (operator override)", async () => {
    await writeFile(
      join(tmp, "defaults.json"),
      JSON.stringify({ static_ip_range: null }),
    );
    const d = await loadDefaults();
    expect(d.static_ip_range).toBeNull();
  });

  test("static_ip_range: explicit operator value persists", async () => {
    await writeFile(
      join(tmp, "defaults.json"),
      JSON.stringify({ static_ip_range: "210-220" }),
    );
    const d = await loadDefaults();
    expect(d.static_ip_range).toBe("210-220");
  });

  test("partial file fills in missing keys from hardcoded", async () => {
    await writeFile(join(tmp, "defaults.json"), JSON.stringify({ cpu: 2 }));
    const d = await loadDefaults();
    expect(d.cpu).toBe(2);
    expect(d.memory).toBe(HARDCODED_DEFAULTS.memory);
    expect(d.disk).toBe(HARDCODED_DEFAULTS.disk);
    expect(d.auto_sleep_seconds).toBe(HARDCODED_DEFAULTS.auto_sleep_seconds);
  });

  test("pool_size defaults to 0 when omitted from file", async () => {
    await writeFile(join(tmp, "defaults.json"), JSON.stringify({ cpu: 2 }));
    const d = await loadDefaults();
    expect(d.pool_size).toBe(0);
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
