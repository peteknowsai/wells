import { describe, expect, test } from "bun:test";
import { composeAuthorizedKeys, composeWellEnv } from "./wellSeed.ts";

describe("composeWellEnv", () => {
  test("emits WELL_HOSTNAME and default WELL_USER", () => {
    const out = composeWellEnv({
      hostname: "pete",
      authorizedKeys: ["ssh-ed25519 AAAA t"],
    });
    expect(out).toContain("WELL_HOSTNAME='pete'");
    expect(out).toContain("WELL_USER='well'");
  });

  test("custom WELL_USER overrides default", () => {
    const out = composeWellEnv({
      hostname: "pete",
      user: "agent",
      authorizedKeys: ["ssh-ed25519 AAAA t"],
    });
    expect(out).toContain("WELL_USER='agent'");
  });

  test("appends env entries with shell-safe quoting", () => {
    const out = composeWellEnv({
      hostname: "pete",
      authorizedKeys: ["ssh-ed25519 AAAA t"],
      env: {
        SIMPLE: "hello",
        WITH_SPACE: "hi there",
        WITH_QUOTE: "she said 'hi'",
        WITH_DOLLAR: "$NOT_EXPANDED",
      },
    });
    expect(out).toContain("SIMPLE='hello'");
    expect(out).toContain("WITH_SPACE='hi there'");
    expect(out).toContain(`WITH_QUOTE='she said '\\''hi'\\''`);
    expect(out).toContain("WITH_DOLLAR='$NOT_EXPANDED'");
  });

  test("rejects newlines in values", () => {
    expect(() =>
      composeWellEnv({
        hostname: "pete",
        authorizedKeys: ["ssh-ed25519 AAAA t"],
        env: { BAD: "line1\nline2" },
      }),
    ).toThrow("newlines");
  });

  test("rejects invalid env key shapes", () => {
    expect(() =>
      composeWellEnv({
        hostname: "pete",
        authorizedKeys: ["ssh-ed25519 AAAA t"],
        env: { "1BAD": "x" },
      }),
    ).toThrow("invalid env key");
    expect(() =>
      composeWellEnv({
        hostname: "pete",
        authorizedKeys: ["ssh-ed25519 AAAA t"],
        env: { "BAD-KEY": "x" },
      }),
    ).toThrow("invalid env key");
  });
});

describe("composeAuthorizedKeys", () => {
  test("one key per line, trailing newline", () => {
    const out = composeAuthorizedKeys(["ssh-ed25519 AAAA k1", "ssh-rsa BBBB k2"]);
    expect(out).toBe("ssh-ed25519 AAAA k1\nssh-rsa BBBB k2\n");
  });

  test("requires at least one key", () => {
    expect(() => composeAuthorizedKeys([])).toThrow("at least one");
  });
});
