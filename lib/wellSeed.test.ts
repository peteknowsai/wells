import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWellSeed,
  composeAuthorizedKeys,
  composeEtcEnvironment,
  composeWellEnv,
} from "./wellSeed.ts";

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

describe("composeEtcEnvironment", () => {
  test("returns empty string when no env passthrough", () => {
    expect(
      composeEtcEnvironment({ hostname: "h", authorizedKeys: ["k"] }),
    ).toBe("");
    expect(
      composeEtcEnvironment({ hostname: "h", authorizedKeys: ["k"], env: {} }),
    ).toBe("");
  });

  test("emits double-quoted KEY=VALUE per --env entry", () => {
    const out = composeEtcEnvironment({
      hostname: "h",
      authorizedKeys: ["k"],
      env: { CELLS_PROXY_SECRET: "xyz", FOO: "bar" },
    });
    expect(out).toContain('CELLS_PROXY_SECRET="xyz"');
    expect(out).toContain('FOO="bar"');
    expect(out.endsWith("\n")).toBe(true);
  });

  test("does NOT emit WELL_HOSTNAME or WELL_USER", () => {
    const out = composeEtcEnvironment({
      hostname: "h",
      user: "cell",
      authorizedKeys: ["k"],
      env: { FOO: "bar" },
    });
    expect(out).not.toContain("WELL_HOSTNAME");
    expect(out).not.toContain("WELL_USER");
  });

  test("escapes embedded backslash and double-quote", () => {
    const out = composeEtcEnvironment({
      hostname: "h",
      authorizedKeys: ["k"],
      env: { TRICKY: 'a"b\\c' },
    });
    expect(out).toContain('TRICKY="a\\"b\\\\c"');
  });

  test("rejects invalid keys + newline values", () => {
    expect(() =>
      composeEtcEnvironment({
        hostname: "h",
        authorizedKeys: ["k"],
        env: { "BAD-KEY": "v" },
      }),
    ).toThrow("invalid env key");
    expect(() =>
      composeEtcEnvironment({
        hostname: "h",
        authorizedKeys: ["k"],
        env: { OK: "line1\nline2" },
      }),
    ).toThrow("newlines");
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

// End-to-end tests for buildWellSeed: build a real cidata.iso via
// hdiutil, mount it read-only, inspect what well-firstboot.sh would
// actually see at boot time. Validates the conditional staging
// (etc-environment.append only present when env passthrough provided)
// + file contents + hdiutil invocation success. macOS-only.
describe("buildWellSeed (hdiutil round-trip)", () => {
  async function mountAndRead(
    isoPath: string,
  ): Promise<{ files: Record<string, string>; unmount: () => Promise<void> }> {
    const mountPoint = await mkdtemp(join(tmpdir(), "well-seed-mount-"));
    const attach = spawn(
      ["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, isoPath],
      { stdout: "ignore", stderr: "pipe" },
    );
    const attachCode = await attach.exited;
    if (attachCode !== 0) {
      const err = await new Response(attach.stderr).text();
      throw new Error(`hdiutil attach failed (${attachCode}): ${err}`);
    }
    const fileNames = ["well.env", "etc-environment.append", "authorized_keys"];
    const files: Record<string, string> = {};
    for (const name of fileNames) {
      try {
        files[name] = await readFile(join(mountPoint, name), "utf-8");
      } catch {
        // File absent — fine, that's part of what we're testing.
      }
    }
    const unmount = async () => {
      const detach = spawn(
        ["hdiutil", "detach", mountPoint],
        { stdout: "ignore", stderr: "ignore" },
      );
      await detach.exited;
      await rm(mountPoint, { recursive: true, force: true });
    };
    return { files, unmount };
  }

  test("writes well.env + authorized_keys, omits etc-environment.append when no env", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "well-seed-out-")), "cidata.iso");
    await buildWellSeed(
      {
        hostname: "test-no-env",
        authorizedKeys: ["ssh-ed25519 AAAAKEY1 test"],
      },
      out,
    );
    const { files, unmount } = await mountAndRead(out);
    try {
      expect(files["well.env"]).toContain("WELL_HOSTNAME='test-no-env'");
      expect(files["well.env"]).toContain("WELL_USER='well'");
      expect(files["authorized_keys"]).toContain("ssh-ed25519 AAAAKEY1 test");
      expect(files["etc-environment.append"]).toBeUndefined();
    } finally {
      await unmount();
      await rm(out, { force: true });
    }
  });

  test("writes etc-environment.append when env is provided + content matches PAM dialect", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "well-seed-out-")), "cidata.iso");
    await buildWellSeed(
      {
        hostname: "test-with-env",
        user: "cell",
        authorizedKeys: ["ssh-ed25519 AAAAKEY2 test"],
        env: {
          CELLS_PROXY_SECRET: "smoke-token-2026",
          MODEL_NAME: "claude-opus",
        },
      },
      out,
    );
    const { files, unmount } = await mountAndRead(out);
    try {
      expect(files["well.env"]).toContain("WELL_USER='cell'");
      // well.env carries the env passthroughs too (for the well user's shell).
      expect(files["well.env"]).toContain("CELLS_PROXY_SECRET='smoke-token-2026'");
      // etc-environment.append is double-quoted (PAM dialect), no shell escape.
      expect(files["etc-environment.append"]).toContain(
        'CELLS_PROXY_SECRET="smoke-token-2026"',
      );
      expect(files["etc-environment.append"]).toContain('MODEL_NAME="claude-opus"');
      // PAM dialect must NOT include the wells-internal WELL_* vars.
      expect(files["etc-environment.append"]).not.toContain("WELL_HOSTNAME");
      expect(files["etc-environment.append"]).not.toContain("WELL_USER");
    } finally {
      await unmount();
      await rm(out, { force: true });
    }
  });

  test("rejects empty hostname before invoking hdiutil", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "well-seed-out-")), "cidata.iso");
    await expect(
      buildWellSeed(
        {
          hostname: "",
          authorizedKeys: ["ssh-ed25519 AAAA test"],
        },
        out,
      ),
    ).rejects.toThrow("hostname required");
  });
});
