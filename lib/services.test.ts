import { describe, expect, test } from "bun:test";
import {
  composeEnvFile,
  composeRunScript,
  composeUnit,
  validateServiceId,
} from "./services.ts";

describe("validateServiceId", () => {
  test("accepts plain alphanumeric ids", () => {
    expect(() => validateServiceId("site")).not.toThrow();
    expect(() => validateServiceId("agent_1")).not.toThrow();
    expect(() => validateServiceId("a-b-c")).not.toThrow();
  });
  test("rejects path-traversal and shell metas", () => {
    for (const bad of ["", "../etc", "with space", "a;b", "a/b", "a$b", "a.b"]) {
      expect(() => validateServiceId(bad)).toThrow();
    }
  });
});

describe("composeRunScript", () => {
  test("emits bash exec with shell-escaped args", () => {
    const out = composeRunScript({
      cmd: "bun",
      args: ["run", "server.ts"],
      workdir: "/home/ubuntu/agent/site",
    });
    expect(out).toBe("#!/usr/bin/env bash\nexec bun run server.ts\n");
  });
  test("single-quotes anything with shell metacharacters", () => {
    const out = composeRunScript({
      cmd: "bash",
      args: ["-lc", "echo hi; ls"],
      workdir: "/tmp",
    });
    expect(out).toContain("exec bash -lc 'echo hi; ls'\n");
  });
  test("escapes embedded single quotes", () => {
    const out = composeRunScript({
      cmd: "echo",
      args: ["it's me"],
      workdir: "/tmp",
    });
    expect(out).toContain("exec echo 'it'\\''s me'\n");
  });
});

describe("composeUnit", () => {
  const baseDef = {
    cmd: "bun",
    args: ["run", "server.ts"],
    workdir: "/home/ubuntu/agent/site",
  };

  test("includes Restart=always by default (auto_restart implicit)", () => {
    const out = composeUnit("site", baseDef, false);
    expect(out).toContain("Restart=always");
    expect(out).toContain("RestartSec=2");
  });

  test("omits Restart= when auto_restart is false", () => {
    const out = composeUnit("site", { ...baseDef, auto_restart: false }, false);
    expect(out).not.toContain("Restart=");
  });

  test("references the wrapper script, not cmd directly", () => {
    const out = composeUnit("site", baseDef, false);
    expect(out).toContain("ExecStart=/etc/well/site.run");
    expect(out).not.toContain("ExecStart=bun");
  });

  test("includes WorkingDirectory and runs as ubuntu by default", () => {
    const out = composeUnit("site", baseDef, false);
    expect(out).toContain("WorkingDirectory=/home/ubuntu/agent/site");
    expect(out).toContain("User=ubuntu");
  });

  test("user field overrides the User= directive (cells team's --user=cell)", () => {
    const out = composeUnit("site", { ...baseDef, user: "cell" }, false);
    expect(out).toContain("User=cell");
    expect(out).not.toContain("User=ubuntu");
  });

  test("rejects malformed user shapes (POSIX-username only)", () => {
    expect(() =>
      composeUnit("site", { ...baseDef, user: "rm -rf /" }, false),
    ).toThrow("invalid");
    expect(() =>
      composeUnit("site", { ...baseDef, user: "" }, false),
    ).not.toThrow(); // empty falls through to default
  });

  test("emits EnvironmentFile only when env file present", () => {
    expect(composeUnit("site", baseDef, false)).not.toContain("EnvironmentFile=");
    expect(composeUnit("site", baseDef, true)).toContain(
      "EnvironmentFile=/etc/well/site.env",
    );
  });

  test("targets multi-user.target so it survives reboot", () => {
    const out = composeUnit("site", baseDef, false);
    expect(out).toContain("WantedBy=multi-user.target");
  });
});

describe("composeEnvFile", () => {
  test("returns null when env is undefined or empty", () => {
    expect(composeEnvFile(undefined)).toBeNull();
    expect(composeEnvFile({})).toBeNull();
  });

  test("emits KEY='value' lines", () => {
    const out = composeEnvFile({ FOO: "bar", PORT: "8080" });
    expect(out).toContain("FOO='bar'");
    expect(out).toContain("PORT='8080'");
    expect(out!.endsWith("\n")).toBe(true);
  });

  test("escapes embedded single quotes in values", () => {
    const out = composeEnvFile({ MSG: "it's me" });
    expect(out).toContain("MSG='it'\\''s me'");
  });

  test("rejects keys that aren't valid environment variable names", () => {
    expect(() => composeEnvFile({ "1FOO": "x" })).toThrow();
    expect(() => composeEnvFile({ "FOO-BAR": "x" })).toThrow();
    expect(() => composeEnvFile({ "": "x" })).toThrow();
  });
});
