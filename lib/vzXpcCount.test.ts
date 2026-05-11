import { describe, expect, test } from "bun:test";
import { parseVzXpcLines } from "./vzXpcCount.ts";

// parseVzXpcLines counts running VZ XPC children from a `ps -A -o pid=,
// command=` dump. Cells team's `/healthz` reads the count and compares
// it to `lume.vm_count` to detect orphans from a crashed lume serve.
// Drift between the substring filter here and the Swift-side filter at
// engine/vwell-src/src/Virtualization/XPCChildLocator.swift would be a
// silent observability bug — tests pin the substring.

describe("parseVzXpcLines", () => {
  test("returns 0 when no matching lines", () => {
    const ps = [
      "1234 /usr/sbin/cfprefsd",
      "5678 /System/Library/Frameworks/Foo",
      "9012 -bash",
    ].join("\n");
    expect(parseVzXpcLines(ps)).toBe(0);
  });

  test("counts one VZ XPC line", () => {
    const ps = [
      "1234 /usr/sbin/cfprefsd",
      "5678 /System/Library/Frameworks/Virtualization.framework/Resources/Virtualization.VirtualMachine.xpc/Contents/MacOS/Virtualization.VirtualMachine pete",
      "9012 -bash",
    ].join("\n");
    expect(parseVzXpcLines(ps)).toBe(1);
  });

  test("counts multiple VZ XPC lines (multi-well host)", () => {
    const ps = [
      "1234 .../Virtualization.VirtualMachine well-a",
      "5678 /usr/sbin/cfprefsd",
      "9012 .../Virtualization.VirtualMachine well-b",
      "3456 .../Virtualization.VirtualMachine well-c",
    ].join("\n");
    expect(parseVzXpcLines(ps)).toBe(3);
  });

  test("returns 0 on empty input", () => {
    expect(parseVzXpcLines("")).toBe(0);
  });

  test("ignores lines that don't contain the marker exactly", () => {
    // Substring match is intentional — Apple's exec path embeds the
    // marker mid-string. We don't anchor at word boundaries.
    const ps = [
      "1234 some-process Virtualization.VirtualMachineSomethingElse",
      "5678 another VirtualMachine but no marker prefix",
    ].join("\n");
    // First line still matches (substring contains "Virtualization.VirtualMachine").
    // Second doesn't.
    expect(parseVzXpcLines(ps)).toBe(1);
  });

  test("handles trailing newline gracefully (typical ps output)", () => {
    const ps = "1234 .../Virtualization.VirtualMachine well-a\n";
    expect(parseVzXpcLines(ps)).toBe(1);
  });
});
