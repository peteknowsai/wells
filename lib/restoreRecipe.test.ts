import { describe, expect, test } from "bun:test";
import { computeConfigHash } from "./restoreRecipe.ts";

describe("computeConfigHash", () => {
  test("same inputs produce same hash", () => {
    const cfg = {
      cpuCount: 4,
      memorySize: 1073741824,
      display: "1024x768",
      networkMode: "nat",
      diskSize: 53687091200,
      os: "linux",
      macAddress: "fe:e8:4c:5d:bf:b9",
    };
    const a = computeConfigHash(cfg, "/path/cidata.iso");
    const b = computeConfigHash(cfg, "/path/cidata.iso");
    expect(a).toBe(b);
  });

  test("different cidata path bumps the hash", () => {
    const cfg = { cpuCount: 4, memorySize: 1024, display: "x" };
    const a = computeConfigHash(cfg, "/path/cidata.iso");
    const b = computeConfigHash(cfg, "/other/cidata.iso");
    expect(a).not.toBe(b);
  });

  test("different cpuCount bumps the hash", () => {
    const a = computeConfigHash({ cpuCount: 2, memorySize: 1024 }, "/x");
    const b = computeConfigHash({ cpuCount: 4, memorySize: 1024 }, "/x");
    expect(a).not.toBe(b);
  });

  test("different memorySize bumps the hash", () => {
    const a = computeConfigHash({ cpuCount: 4, memorySize: 1024 }, "/x");
    const b = computeConfigHash({ cpuCount: 4, memorySize: 2048 }, "/x");
    expect(a).not.toBe(b);
  });

  test("different MAC bumps the hash", () => {
    const a = computeConfigHash(
      { cpuCount: 4, memorySize: 1024, macAddress: "aa:bb:cc:dd:ee:ff" },
      "/x",
    );
    const b = computeConfigHash(
      { cpuCount: 4, memorySize: 1024, macAddress: "11:22:33:44:55:66" },
      "/x",
    );
    expect(a).not.toBe(b);
  });

  test("hash is hex sha256 — 64 chars", () => {
    const h = computeConfigHash({ cpuCount: 4, memorySize: 1024 }, "/x");
    expect(h.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });

  test("missing optional fields are stable (canonical encoding)", () => {
    // Both configs have the same effective shape — undefined fields
    // serialize to nothing (JSON.stringify drops them). Hashes match.
    const a = computeConfigHash({ cpuCount: 4, memorySize: 1024 }, "/x");
    const b = computeConfigHash(
      { cpuCount: 4, memorySize: 1024, networkMode: undefined },
      "/x",
    );
    expect(a).toBe(b);
  });
});
