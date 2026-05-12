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

  test("rejects pool- prefix (held for the pre-warmed pool's internal members)", () => {
    expect(() => validateWellName("pool-12345678")).toThrow(/pool-.*reserved/);
    expect(() => validateWellName("pool-1")).toThrow(/pool-.*reserved/);
    // Operator names containing 'pool' but not as prefix are fine.
    expect(() => validateWellName("my-pool")).not.toThrow();
    expect(() => validateWellName("apool")).not.toThrow();
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

  test("sizeToTruncateArg rejects invalid input", () => {
    expect(() => sizeToTruncateArg("garbage")).toThrow("invalid size");
    expect(() => sizeToTruncateArg("50")).toThrow("invalid size");
    expect(() => sizeToTruncateArg("")).toThrow("invalid size");
  });

  test("sizeToTruncateArg accepts lowercase + whitespace (uses normalize regex)", () => {
    expect(sizeToTruncateArg("50gb")).toBe("50G");
    expect(sizeToTruncateArg(" 4mb ")).toBe("4M");
  });

  test("isReservedName covers the canonical reserved set", () => {
    // Reserved names — directly checked rather than going through
    // validateWellName so a reader can see exactly which strings are
    // off-limits.
    expect(isReservedName("mother")).toBe(true);
    expect(isReservedName("keeper")).toBe(true);
    expect(isReservedName("wells-base")).toBe(true);
    expect(isReservedName("wells-base-stage")).toBe(true);
    expect(isReservedName("localhost")).toBe(true);
    expect(isReservedName("broadcast")).toBe(true);
    expect(isReservedName("host")).toBe(true);
    expect(isReservedName("default")).toBe(true);
  });

  test("isReservedName returns false for ordinary names", () => {
    expect(isReservedName("pete")).toBe(false);
    expect(isReservedName("cell-1")).toBe(false);
    expect(isReservedName("")).toBe(false); // empty isn't reserved; validateWellName catches it via NAME_RE
  });
});
