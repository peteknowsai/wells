import { describe, expect, test } from "bun:test";
import { extractWellFromHost, publicBase } from "./proxy.ts";

describe("extractWellFromHost", () => {
  const base = "wells.cells.md";

  test("extracts a single-label well name", () => {
    expect(extractWellFromHost("pete.wells.cells.md", base)).toBe("pete");
  });

  test("strips a port from the Host header", () => {
    expect(extractWellFromHost("pete.wells.cells.md:443", base)).toBe("pete");
  });

  test("is case-insensitive", () => {
    expect(extractWellFromHost("Pete.WELLS.cells.md", base)).toBe("pete");
  });

  test("rejects multi-label prefixes (no smuggling via attacker.com)", () => {
    expect(
      extractWellFromHost("pete.attacker.com.wells.cells.md", base),
    ).toBeNull();
  });

  test("rejects bare base", () => {
    expect(extractWellFromHost("wells.cells.md", base)).toBeNull();
  });

  test("rejects unrelated domains", () => {
    expect(extractWellFromHost("pete.cells.md", base)).toBeNull();
    expect(extractWellFromHost("pete.example.com", base)).toBeNull();
  });

  test("rejects null host", () => {
    expect(extractWellFromHost(null, base)).toBeNull();
  });
});

describe("publicBase", () => {
  test("returns null when WELL_PUBLIC_BASE is unset", () => {
    const prev = process.env.WELL_PUBLIC_BASE;
    delete process.env.WELL_PUBLIC_BASE;
    expect(publicBase()).toBeNull();
    if (prev !== undefined) process.env.WELL_PUBLIC_BASE = prev;
  });

  test("trims whitespace and returns the value", () => {
    process.env.WELL_PUBLIC_BASE = "  wells.cells.md  ";
    expect(publicBase()).toBe("wells.cells.md");
    delete process.env.WELL_PUBLIC_BASE;
  });

  test("returns null on empty string", () => {
    process.env.WELL_PUBLIC_BASE = "";
    expect(publicBase()).toBeNull();
    delete process.env.WELL_PUBLIC_BASE;
  });
});
