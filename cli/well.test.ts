import { describe, expect, test } from "bun:test";
import { fmtBytes, parseFlag, resolveName } from "./well.ts";

// Three pure helpers from the CLI worth pinning:
//   - fmtBytes: renders disk-used / sizes for `well info` / `well list`
//   - parseFlag: extracts --foo=value style flags from argv
//   - resolveName: picks "which well" from -s, --well, or the .well pin

describe("fmtBytes", () => {
  test("bytes under 1024 render as raw bytes", () => {
    expect(fmtBytes(0)).toBe("0B");
    expect(fmtBytes(1)).toBe("1B");
    expect(fmtBytes(1023)).toBe("1023B");
  });

  test("flips to KB at 1024", () => {
    expect(fmtBytes(1024)).toBe("1.0KB");
    expect(fmtBytes(1536)).toBe("1.5KB");
  });

  test("MB / GB / TB scaling", () => {
    expect(fmtBytes(1024 * 1024)).toBe("1.0MB");
    expect(fmtBytes(1024 ** 3)).toBe("1.0GB");
    expect(fmtBytes(1024 ** 4)).toBe("1.0TB");
  });

  test("caps at TB for very large values (no PB unit)", () => {
    // 1024^5 = PB; we stop at TB and overflow into the value.
    expect(fmtBytes(1024 ** 5)).toBe("1024.0TB");
  });

  test("one-decimal precision", () => {
    expect(fmtBytes(1500 * 1024)).toBe("1.5MB");
    expect(fmtBytes(1700 * 1024 * 1024)).toBe("1.7GB");
  });
});

describe("parseFlag", () => {
  test("extracts --name=value", () => {
    expect(parseFlag(["--cpu=4"], "cpu")).toBe("4");
    expect(parseFlag(["--memory=4GB"], "memory")).toBe("4GB");
  });

  test("returns undefined when flag absent", () => {
    expect(parseFlag(["--cpu=4"], "memory")).toBeUndefined();
    expect(parseFlag([], "anything")).toBeUndefined();
  });

  test("does NOT match space-separated (--name value)", () => {
    // Only `=` syntax; `--name value` is handled by callers' positional walk.
    expect(parseFlag(["--cpu", "4"], "cpu")).toBeUndefined();
  });

  test("first match wins for duplicates", () => {
    expect(parseFlag(["--cpu=4", "--cpu=8"], "cpu")).toBe("4");
  });

  test("preserves embedded equals + complex values", () => {
    // CELLS_PROXY_SECRET=abc=def style — the slice after first `=` keeps everything.
    expect(parseFlag(["--env=CELLS_PROXY_SECRET=abc=def"], "env")).toBe(
      "CELLS_PROXY_SECRET=abc=def",
    );
  });

  test("empty value (--name=) returns empty string, not undefined", () => {
    expect(parseFlag(["--name="], "name")).toBe("");
  });
});

describe("resolveName", () => {
  test("returns the value after -s", () => {
    expect(resolveName(["-s", "pete"], undefined)).toBe("pete");
  });

  test("returns the value after --well", () => {
    expect(resolveName(["--well", "petes-cell"], undefined)).toBe("petes-cell");
  });

  test("-s wins over .well pin", () => {
    expect(resolveName(["-s", "explicit"], "pinned")).toBe("explicit");
  });

  test("falls back to pin when no -s/--well", () => {
    expect(resolveName([], "pinned")).toBe("pinned");
  });

  test("returns undefined when no flag and no pin", () => {
    expect(resolveName([], undefined)).toBeUndefined();
  });

  test("-s with no trailing value returns undefined", () => {
    // `well exec -s` with nothing after — args[sIdx+1] is undefined.
    expect(resolveName(["-s"], "pinned")).toBeUndefined();
  });

  test("ignores positional args (only -s / --well are resolution sources)", () => {
    expect(resolveName(["pete", "destroy"], "pinned")).toBe("pinned");
  });
});
