import { describe, expect, test } from "bun:test";
import {
  allocatePinnedIp,
  PIN_RANGE_END,
  PIN_RANGE_START,
} from "./pinIp.ts";

describe("allocatePinnedIp", () => {
  test("returns the lowest IP in range when nothing taken", () => {
    expect(allocatePinnedIp([])).toBe(`192.168.64.${PIN_RANGE_START}`);
  });

  test("skips IPs already taken", () => {
    const taken = ["192.168.64.100", "192.168.64.101"];
    expect(allocatePinnedIp(taken)).toBe("192.168.64.102");
  });

  test("ignores out-of-range entries when computing taken", () => {
    // .8 is below the pin range; should not affect allocation.
    const taken = ["192.168.64.8", "192.168.64.100"];
    expect(allocatePinnedIp(taken)).toBe("192.168.64.101");
  });

  test("returns null when full", () => {
    const taken: string[] = [];
    for (let i = PIN_RANGE_START; i <= PIN_RANGE_END; i++) {
      taken.push(`192.168.64.${i}`);
    }
    expect(allocatePinnedIp(taken)).toBeNull();
  });

  test("returns next free when a middle slot is open", () => {
    const taken = new Set<string>();
    for (let i = PIN_RANGE_START; i < 150; i++) taken.add(`192.168.64.${i}`);
    // 150 is open
    for (let i = 151; i <= PIN_RANGE_END; i++) taken.add(`192.168.64.${i}`);
    expect(allocatePinnedIp(taken)).toBe("192.168.64.150");
  });
});

