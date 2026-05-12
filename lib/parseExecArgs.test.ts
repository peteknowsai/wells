import { describe, expect, test } from "bun:test";
import { parseExecArgs } from "./parseExecArgs.ts";

describe("parseExecArgs", () => {
  test("simple command with -s", () => {
    expect(parseExecArgs(["-s", "pete", "--", "ls", "/etc"])).toEqual({
      well: "pete",
      tty: false,
      cmd: ["ls", "/etc"],
      user: undefined,
    });
  });

  test("--well long form", () => {
    expect(parseExecArgs(["--well", "pete", "--", "uname"])).toEqual({
      well: "pete",
      tty: false,
      cmd: ["uname"],
      user: undefined,
    });
  });

  test("--user / -u flag captures override", () => {
    expect(parseExecArgs(["--user", "ubuntu", "--", "ls"]).user).toBe("ubuntu");
    expect(parseExecArgs(["-u", "root", "--", "ls"]).user).toBe("root");
  });

  test("user undefined when --user not provided", () => {
    expect(parseExecArgs(["--", "ls"]).user).toBeUndefined();
  });

  test("--user without value is an error", () => {
    expect(() => parseExecArgs(["--user", "--", "ls"])).toThrow(/requires a value/);
  });

  test("--tty + -t both work", () => {
    expect(parseExecArgs(["--tty", "--", "bash"]).tty).toBe(true);
    expect(parseExecArgs(["-t", "--", "bash"]).tty).toBe(true);
  });

  test("no -s falls through to undefined well", () => {
    expect(parseExecArgs(["--", "true"]).well).toBeUndefined();
  });

  test("preserves command arg order + complex args", () => {
    expect(parseExecArgs(["--", "tar", "xz", "-C", "/target"]).cmd).toEqual([
      "tar", "xz", "-C", "/target",
    ]);
  });

  test("missing -- is an error", () => {
    expect(() => parseExecArgs(["-s", "pete", "ls"])).toThrow(/missing '--'/);
  });

  test("empty command after -- is an error", () => {
    expect(() => parseExecArgs(["-s", "pete", "--"])).toThrow(/no command/);
  });

  test("unknown flag is an error", () => {
    expect(() => parseExecArgs(["--foo", "--", "ls"])).toThrow(/unknown flag/);
  });

  test("-s without value is an error", () => {
    expect(() => parseExecArgs(["-s", "--", "ls"])).toThrow(/requires a value/);
  });

  test("--user=value equals syntax (cells team automation)", () => {
    expect(parseExecArgs(["--user=cell", "--", "ls"]).user).toBe("cell");
  });

  test("--well=value equals syntax", () => {
    expect(parseExecArgs(["--well=pete", "--", "ls"]).well).toBe("pete");
  });

  test("-s=value short equals syntax", () => {
    expect(parseExecArgs(["-s=pete", "--", "ls"]).well).toBe("pete");
  });

  test("-u=value short equals syntax", () => {
    expect(parseExecArgs(["-u=cell", "--", "ls"]).user).toBe("cell");
  });

  test("--user= with empty value is an error", () => {
    expect(() => parseExecArgs(["--user=", "--", "ls"])).toThrow(/requires a value/);
  });

  test("--tty=anything is an error (boolean flag takes no value)", () => {
    expect(() => parseExecArgs(["--tty=yes", "--", "ls"])).toThrow(/takes no value/);
  });

  test("equals syntax is positional-safe — value can contain '='", () => {
    // Edge case: --user=user=admin should treat the FIRST '=' as the
    // separator. Some IAM-style usernames contain '='.
    expect(parseExecArgs(["--user=foo=bar", "--", "ls"]).user).toBe("foo=bar");
  });
});
