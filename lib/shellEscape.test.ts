import { describe, expect, test } from "bun:test";
import { shellEscape } from "./shellEscape.ts";

describe("shellEscape", () => {
  test("passes through safe chars unquoted", () => {
    expect(shellEscape("hello")).toBe("hello");
    expect(shellEscape("/usr/bin/env")).toBe("/usr/bin/env");
    expect(shellEscape("foo_bar.baz")).toBe("foo_bar.baz");
    expect(shellEscape("a-b-c")).toBe("a-b-c");
  });

  test("quotes anything with shell metacharacters", () => {
    expect(shellEscape("echo hi; ls")).toBe("'echo hi; ls'");
    expect(shellEscape("a|b")).toBe("'a|b'");
    expect(shellEscape("$VAR")).toBe("'$VAR'");
    expect(shellEscape("with space")).toBe("'with space'");
  });

  test("escapes embedded single quotes via the '\\'' trick", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  test("quotes empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  test("round-trips through bash", async () => {
    // Sanity: feed an escaped value to bash -c and verify it reads back unchanged.
    const cases = ["hello", "echo hi; ls", "$PATH", "it's me", "a\nb", "with \"quotes\""];
    for (const original of cases) {
      const escaped = shellEscape(original);
      const proc = Bun.spawn(["bash", "-c", `printf %s ${escaped}`], { stdout: "pipe" });
      const out = await new Response(proc.stdout).text();
      expect(out).toBe(original);
    }
  });
});
