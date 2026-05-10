import { describe, expect, test } from "bun:test";
import { shouldFill } from "./poolFiller.ts";

// `shouldFill` is the gap-detection logic at the heart of the filler.
// Pure helper — covers the matrix without spinning up a live filler.
describe("shouldFill", () => {
  test("pool_size=0 disables the filler regardless of state", () => {
    expect(shouldFill(0, 0, false)).toBe(false);
    expect(shouldFill(0, 0, true)).toBe(false);
    expect(shouldFill(0, 5, false)).toBe(false);
  });

  test("negative pool_size also disables (defensive against bad config)", () => {
    expect(shouldFill(-1, 0, false)).toBe(false);
  });

  test("inflight blocks fill regardless of gap", () => {
    expect(shouldFill(2, 0, true)).toBe(false);
    expect(shouldFill(4, 1, true)).toBe(false);
  });

  test("ready < target + no inflight → fill", () => {
    expect(shouldFill(1, 0, false)).toBe(true);
    expect(shouldFill(4, 3, false)).toBe(true);
  });

  test("ready === target → no fill (steady state)", () => {
    expect(shouldFill(2, 2, false)).toBe(false);
  });

  test("ready > target → no fill (over-pooled, no shrink)", () => {
    // Over-pool can happen if pool_size was lowered after fill. We
    // don't shrink — drain is a separate operator action.
    expect(shouldFill(2, 5, false)).toBe(false);
  });
});
