import { describe, expect, test } from "bun:test";
import {
  isReservedName,
  normalizeSize,
  sizeToTruncateArg,
  validateWellName,
} from "./wellPolicy.ts";

describe("well name policy", () => {
  test("accepts simple names", () => {
    expect(() => validateWellName("pete")).not.toThrow();
    expect(() => validateWellName("a")).not.toThrow();
    expect(() => validateWellName("foo-bar-1")).not.toThrow();
  });

  test("rejects uppercase", () => {
    expect(() => validateWellName("Pete")).toThrow(/invalid well name/);
  });

  test("rejects leading/trailing hyphen", () => {
    expect(() => validateWellName("-pete")).toThrow();
    expect(() => validateWellName("pete-")).toThrow();
  });

  test("rejects underscore + dot", () => {
    expect(() => validateWellName("pete_1")).toThrow();
    expect(() => validateWellName("pete.1")).toThrow();
  });

  test("rejects reserved names", () => {
    expect(() => validateWellName("mother")).toThrow(/reserved/);
    expect(() => validateWellName("keeper")).toThrow(/reserved/);
    expect(() => validateWellName("wells-base")).toThrow(/reserved/);
    expect(isReservedName("mother")).toBe(true);
    expect(isReservedName("pete")).toBe(false);
  });

  test("rejects empty + over-long", () => {
    expect(() => validateWellName("")).toThrow();
    expect(() => validateWellName("a".repeat(64))).toThrow();
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
