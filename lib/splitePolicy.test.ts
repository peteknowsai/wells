import { describe, expect, test } from "bun:test";
import {
  isReservedName,
  normalizeSize,
  sizeToTruncateArg,
  validateSpliteName,
} from "./splitePolicy.ts";

describe("splite name policy", () => {
  test("accepts simple names", () => {
    expect(() => validateSpliteName("pete")).not.toThrow();
    expect(() => validateSpliteName("a")).not.toThrow();
    expect(() => validateSpliteName("foo-bar-1")).not.toThrow();
  });

  test("rejects uppercase", () => {
    expect(() => validateSpliteName("Pete")).toThrow(/invalid splite name/);
  });

  test("rejects leading/trailing hyphen", () => {
    expect(() => validateSpliteName("-pete")).toThrow();
    expect(() => validateSpliteName("pete-")).toThrow();
  });

  test("rejects underscore + dot", () => {
    expect(() => validateSpliteName("pete_1")).toThrow();
    expect(() => validateSpliteName("pete.1")).toThrow();
  });

  test("rejects reserved names", () => {
    expect(() => validateSpliteName("mother")).toThrow(/reserved/);
    expect(() => validateSpliteName("keeper")).toThrow(/reserved/);
    expect(() => validateSpliteName("splites-base")).toThrow(/reserved/);
    expect(isReservedName("mother")).toBe(true);
    expect(isReservedName("pete")).toBe(false);
  });

  test("rejects empty + over-long", () => {
    expect(() => validateSpliteName("")).toThrow();
    expect(() => validateSpliteName("a".repeat(64))).toThrow();
  });
});

describe("size parsing", () => {
  test("normalizeSize uppercases unit", () => {
    expect(normalizeSize("4gb")).toBe("4GB");
    expect(normalizeSize(" 512mb ")).toBe("512MB");
  });

  test("normalizeSize rejects bad input", () => {
    expect(() => normalizeSize("4")).toThrow();
    expect(() => normalizeSize("4G")).toThrow();
  });

  test("sizeToTruncateArg shortens", () => {
    expect(sizeToTruncateArg("50GB")).toBe("50G");
    expect(sizeToTruncateArg("512MB")).toBe("512M");
    expect(sizeToTruncateArg("1TB")).toBe("1T");
  });
});
