import { describe, expect, test } from "bun:test";
import { timingSafeEqual } from "./timingSafe.ts";

// Constant-time string compare used by welld's bearer-token check.
// Behavior tested here; the "constant-time" property is asserted by
// inspection of the implementation, not by timing measurement (timing
// tests are flaky enough to be worse than nothing).

describe("timingSafeEqual", () => {
  test("returns true for equal strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  test("returns false for different strings of the same length", () => {
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("aaa", "aab")).toBe(false);
  });

  test("returns false when lengths differ (early-return)", () => {
    expect(timingSafeEqual("a", "ab")).toBe(false);
    expect(timingSafeEqual("longer", "short")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
  });

  test("returns true for the canonical wells token shape (64 hex chars)", () => {
    const t = "abc123".repeat(10) + "deadbeef"; // 68 chars; pad/truncate to 64
    const t64 = t.slice(0, 64);
    expect(t64.length).toBe(64);
    expect(timingSafeEqual(t64, t64)).toBe(true);
  });

  test("differs in just the first byte → false", () => {
    expect(timingSafeEqual("xbc", "abc")).toBe(false);
  });

  test("differs in just the last byte → false (inspects every byte)", () => {
    // The whole point of the function: don't short-circuit on first
    // mismatch. Behaviorally identical to other false cases, but the
    // intent is constant-time inspection.
    expect(timingSafeEqual("abcdefgh", "abcdefgz")).toBe(false);
  });

  test("handles non-ASCII chars", () => {
    expect(timingSafeEqual("café", "café")).toBe(true);
    expect(timingSafeEqual("café", "cafe")).toBe(false);
  });

  test("does NOT throw on weird inputs (defensive)", () => {
    expect(() => timingSafeEqual("a", "a")).not.toThrow();
    expect(() => timingSafeEqual("", "")).not.toThrow();
  });
});
