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
  test("emits WELL_HOSTNAME", () => {
    const out = composeWellEnv({
      hostname: "pete",
      authorizedKeys: ["ssh-ed25519 AAAA t"],
    });
    expect(out).toContain("WELL_HOSTNAME='pete'");
  });

  test("does not emit WELL_USER (well user dropped — SSH lands as root)", () => {
    const out = composeWellEnv({
      hostname: "pete",
      authorizedKeys: ["ssh-ed25519 AAAA t"],
    });
    expect(out).not.toContain("WELL_USER");
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

  test("staticIp: emits WELL_STATIC_IP_CIDR + WELL_GATEWAY + WELL_NAMESERVERS", () => {
    const out = composeWellEnv({
      hostname: "pete",
      authorizedKeys: ["ssh-ed25519 AAAA t"],
      staticIp: { ip: "192.168.64.215", cidrPrefix: 24 },
    });
    expect(out).toContain("WELL_STATIC_IP_CIDR='192.168.64.215/24'");
    expect(out).toContain("WELL_GATEWAY='192.168.64.1'");
    expect(out).toContain("WELL_NAMESERVERS='192.168.64.1'");
  });

  test("staticIp: honors custom gateway + nameservers", () => {
    const out = composeWellEnv({
      hostname: "pete",
      authorizedKeys: ["k"],
      staticIp: {
        ip: "10.0.0.5",
        cidrPrefix: 16,
        gateway: "10.0.0.1",
        nameservers: ["1.1.1.1", "8.8.8.8"],
      },
    });
    expect(out).toContain("WELL_STATIC_IP_CIDR='10.0.0.5/16'");
    expect(out).toContain("WELL_GATEWAY='10.0.0.1'");
    expect(out).toContain("WELL_NAMESERVERS='1.1.1.1,8.8.8.8'");
  });

  test("staticIp: rejects malformed IP", () => {
    expect(() =>
      composeWellEnv({
        hostname: "pete",
        authorizedKeys: ["k"],
        staticIp: { ip: "192.168.64.999", cidrPrefix: 24 },
      }),
    ).toThrow(/invalid staticIp\.ip/);
    expect(() =>
      composeWellEnv({
        hostname: "pete",
        authorizedKeys: ["k"],
        staticIp: { ip: "192.168.64", cidrPrefix: 24 },
      }),
    ).toThrow(/invalid staticIp\.ip/);
  });

  test("staticIp: rejects bad CIDR prefix", () => {
    expect(() =>
      composeWellEnv({
        hostname: "pete",
        authorizedKeys: ["k"],
        staticIp: { ip: "192.168.64.215", cidrPrefix: 0 },
      }),
    ).toThrow(/cidrPrefix/);
    expect(() =>
      composeWellEnv({
        hostname: "pete",
        authorizedKeys: ["k"],
        staticIp: { ip: "192.168.64.215", cidrPrefix: 33 },
      }),
    ).toThrow(/cidrPrefix/);
  });

  test("staticIp: rejects bad gateway and nameservers", () => {
    expect(() =>
      composeWellEnv({
        hostname: "pete",
        authorizedKeys: ["k"],
        staticIp: { ip: "192.168.64.215", cidrPrefix: 24, gateway: "bad" },
      }),
    ).toThrow(/invalid staticIp\.gateway/);
    expect(() =>
      composeWellEnv({
        hostname: "pete",
        authorizedKeys: ["k"],
        staticIp: {
          ip: "192.168.64.215",
          cidrPrefix: 24,
          nameservers: ["1.1.1.1", "bad"],
        },
      }),
    ).toThrow(/invalid staticIp\.nameservers/);
  });

  test("staticIp: omitted → no WELL_STATIC_IP_CIDR in output (legacy path)", () => {
    const out = composeWellEnv({
      hostname: "pete",
      authorizedKeys: ["k"],
    });
    expect(out).not.toContain("WELL_STATIC_IP_CIDR");
    expect(out).not.toContain("WELL_GATEWAY");
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

  test("does NOT emit WELL_HOSTNAME", () => {
    const out = composeEtcEnvironment({
      hostname: "h",
      authorizedKeys: ["k"],
      env: { FOO: "bar" },
    });
    expect(out).not.toContain("WELL_HOSTNAME");
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
      expect(files["well.env"]).not.toContain("WELL_USER");
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
      // well.env carries the env passthroughs too (sourced by firstboot).
      expect(files["well.env"]).toContain("CELLS_PROXY_SECRET='smoke-token-2026'");
      // etc-environment.append is double-quoted (PAM dialect), no shell escape.
      expect(files["etc-environment.append"]).toContain(
        'CELLS_PROXY_SECRET="smoke-token-2026"',
      );
      expect(files["etc-environment.append"]).toContain('MODEL_NAME="claude-opus"');
      // PAM dialect must NOT include the wells-internal WELL_* vars.
      expect(files["etc-environment.append"]).not.toContain("WELL_HOSTNAME");
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
