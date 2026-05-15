import { describe, test, expect } from "bun:test";
import { parseVmStat, readHostMemory } from "./hostMemory.ts";

describe("parseVmStat", () => {
  test("computes active + wired + compressed × page size", () => {
    const text = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               13400.",
      "Pages active:                            800000.",
      "Pages inactive:                          800000.",
      "Pages speculative:                        20000.",
      "Pages throttled:                              0.",
      "Pages wired down:                        200000.",
      "Pages purgeable:                           5000.",
      "Pages occupied by compressor:            100000.",
    ].join("\n");
    // (800k + 200k + 100k) * 16384 = 1.1M * 16384
    expect(parseVmStat(text)).toBe((800_000 + 200_000 + 100_000) * 16_384);
  });

  test("treats missing compressor line as zero (legacy macOS)", () => {
    const text = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages active:                            800000.",
      "Pages wired down:                        200000.",
    ].join("\n");
    expect(parseVmStat(text)).toBe((800_000 + 200_000) * 16_384);
  });

  test("returns null on missing page size", () => {
    expect(parseVmStat("not the right output")).toBe(null);
  });

  test("returns null on missing required fields", () => {
    const text = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.";
    expect(parseVmStat(text)).toBe(null);
  });

  test("handles 4096 page-size machines", () => {
    const text = [
      "Mach Virtual Memory Statistics: (page size of 4096 bytes)",
      "Pages active:                            1000.",
      "Pages wired down:                         500.",
      "Pages occupied by compressor:             200.",
    ].join("\n");
    expect(parseVmStat(text)).toBe((1000 + 500 + 200) * 4096);
  });
});

describe("readHostMemory (integration)", () => {
  test("returns finite numbers on this Mac", async () => {
    const snap = await readHostMemory();
    // We only assert >0 — actual values vary per machine.
    expect(snap.memory_total_bytes).toBeGreaterThan(0);
    expect(snap.memory_used_bytes).toBeGreaterThan(0);
    expect(snap.memory_used_bytes).toBeLessThan((snap.memory_total_bytes ?? 0) * 1.1);
  });
});
