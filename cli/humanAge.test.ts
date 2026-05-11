import { describe, expect, test } from "bun:test";
import { humanAge } from "./humanAge.ts";

// humanAge renders `well info` / `well list` uptime + creation strings
// like "12s", "3m", "5h", "2d". Pure function on (now, then) — test by
// computing an ISO from a known offset.

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("humanAge", () => {
  test("0s for now", () => {
    expect(humanAge(new Date().toISOString())).toBe("0s");
  });

  test("under 60s renders as <N>s", () => {
    expect(humanAge(isoAgo(5 * SECOND))).toBe("5s");
    expect(humanAge(isoAgo(59 * SECOND))).toBe("59s");
  });

  test("flips to minutes at exactly 60s", () => {
    expect(humanAge(isoAgo(60 * SECOND))).toBe("1m");
  });

  test("minutes render as <N>m through 59m", () => {
    expect(humanAge(isoAgo(5 * MINUTE))).toBe("5m");
    expect(humanAge(isoAgo(59 * MINUTE))).toBe("59m");
  });

  test("flips to hours at exactly 60m", () => {
    expect(humanAge(isoAgo(60 * MINUTE))).toBe("1h");
  });

  test("hours render as <N>h through 47h", () => {
    expect(humanAge(isoAgo(5 * HOUR))).toBe("5h");
    expect(humanAge(isoAgo(47 * HOUR))).toBe("47h");
  });

  test("flips to days at exactly 48h (not 24h)", () => {
    // Deliberate choice in the impl: keep showing hours up to 48 so
    // "yesterday" reads as hours, not "1d". 48h → "2d".
    expect(humanAge(isoAgo(48 * HOUR))).toBe("2d");
  });

  test("days render as <N>d at 48h+", () => {
    expect(humanAge(isoAgo(5 * DAY))).toBe("5d");
    expect(humanAge(isoAgo(30 * DAY))).toBe("30d");
  });

  test("future timestamps render with negative numbers (clock skew tolerance)", () => {
    // Don't throw; just emit whatever floor of negative ms produces.
    // Caller renders this as "well was created X in the future" which
    // operator can ignore — better than crashing on clock skew.
    const future = new Date(Date.now() + 5 * SECOND).toISOString();
    expect(humanAge(future)).toBe("-5s");
  });
});
