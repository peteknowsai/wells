import { test, expect } from "bun:test";
import { parseRssOutput } from "./processMemory.ts";

test("parseRssOutput maps pid to bytes (rss is in KiB)", () => {
  const m = parseRssOutput("  123   456\n789 1024\n");
  expect(m.get(123)).toBe(456 * 1024);
  expect(m.get(789)).toBe(1024 * 1024);
  expect(m.size).toBe(2);
});

test("parseRssOutput skips malformed and blank lines", () => {
  const m = parseRssOutput("PID RSS\n\n  42  100  extra\n7 8\n");
  expect(m.get(7)).toBe(8 * 1024);
  expect(m.has(42)).toBe(false); // three columns — not pid,rss
  expect(m.size).toBe(1);
});

test("parseRssOutput handles empty input", () => {
  expect(parseRssOutput("").size).toBe(0);
});
