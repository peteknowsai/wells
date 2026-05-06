import { describe, expect, test } from "bun:test";
import { parseExecArgs } from "./parseExecArgs.ts";

describe("parseExecArgs", () => {
  test("simple command with -s", () => {
    expect(parseExecArgs(["-s", "pete", "--", "ls", "/etc"])).toEqual({
      splite: "pete",
      tty: false,
      cmd: ["ls", "/etc"],
    });
  });

  test("--splite long form", () => {
    expect(parseExecArgs(["--splite", "pete", "--", "uname"])).toEqual({
      splite: "pete",
      tty: false,
      cmd: ["uname"],
    });
  });

  test("--tty + -t both work", () => {
    expect(parseExecArgs(["--tty", "--", "bash"]).tty).toBe(true);
    expect(parseExecArgs(["-t", "--", "bash"]).tty).toBe(true);
  });

  test("no -s falls through to undefined splite", () => {
    expect(parseExecArgs(["--", "true"]).splite).toBeUndefined();
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
});
