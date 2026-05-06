import { describe, expect, test } from "bun:test";
import { extractSpliteFromHost, publicBase } from "./proxy.ts";

describe("extractSpliteFromHost", () => {
  const base = "splites.cells.md";

  test("extracts a single-label splite name", () => {
    expect(extractSpliteFromHost("pete.splites.cells.md", base)).toBe("pete");
  });

  test("strips a port from the Host header", () => {
    expect(extractSpliteFromHost("pete.splites.cells.md:443", base)).toBe("pete");
  });

  test("is case-insensitive", () => {
    expect(extractSpliteFromHost("Pete.SPLITES.cells.md", base)).toBe("pete");
  });

  test("rejects multi-label prefixes (no smuggling via attacker.com)", () => {
    expect(
      extractSpliteFromHost("pete.attacker.com.splites.cells.md", base),
    ).toBeNull();
  });

  test("rejects bare base", () => {
    expect(extractSpliteFromHost("splites.cells.md", base)).toBeNull();
  });

  test("rejects unrelated domains", () => {
    expect(extractSpliteFromHost("pete.cells.md", base)).toBeNull();
    expect(extractSpliteFromHost("pete.example.com", base)).toBeNull();
  });

  test("rejects null host", () => {
    expect(extractSpliteFromHost(null, base)).toBeNull();
  });
});

describe("publicBase", () => {
  test("returns null when SPLITES_PUBLIC_BASE is unset", () => {
    const prev = process.env.SPLITES_PUBLIC_BASE;
    delete process.env.SPLITES_PUBLIC_BASE;
    expect(publicBase()).toBeNull();
    if (prev !== undefined) process.env.SPLITES_PUBLIC_BASE = prev;
  });

  test("trims whitespace and returns the value", () => {
    process.env.SPLITES_PUBLIC_BASE = "  splites.cells.md  ";
    expect(publicBase()).toBe("splites.cells.md");
    delete process.env.SPLITES_PUBLIC_BASE;
  });

  test("returns null on empty string", () => {
    process.env.SPLITES_PUBLIC_BASE = "";
    expect(publicBase()).toBeNull();
    delete process.env.SPLITES_PUBLIC_BASE;
  });
});
