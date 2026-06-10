import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPersistedServices,
  composeEnvFile,
  composeRunScript,
  composeUnit,
  validateServiceId,
  type ApplyArgs,
} from "./services.ts";
import { PATHS } from "./state.ts";

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

describe("applyPersistedServices", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-services-test-"));
    process.env.WELL_STATE_DIR = tmp;
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  async function persistDef(
    well: string,
    id: string,
    def: Record<string, unknown>,
  ): Promise<void> {
    await mkdir(PATHS.wellServicesDir(well), { recursive: true });
    await writeFile(
      PATHS.serviceFile(well, id),
      JSON.stringify({ id, well, definition: def, created_at: "2026-05-21T00:00:00Z" }),
    );
  }

  const def = {
    cmd: "bun",
    args: ["run", "server.ts"],
    workdir: "/home/ubuntu/agent/site",
  };

  test("no persisted defs → empty result, no guest contact", async () => {
    const applied: ApplyArgs[] = [];
    const result = await applyPersistedServices("ghost", async (a) => {
      applied.push(a);
    });
    expect(result).toEqual({ applied: [], failed: [] });
    expect(applied).toEqual([]);
  });

  test("applies every persisted def with composed unit/run/env", async () => {
    await persistDef("mother", "site", def);
    await persistDef("mother", "agent", { ...def, env: { PORT: "8080" } });

    const seen: ApplyArgs[] = [];
    const result = await applyPersistedServices("mother", async (a) => {
      seen.push(a);
    });

    // listServices sorts by id — agent before site.
    expect(result.applied).toEqual(["agent", "site"]);
    expect(result.failed).toEqual([]);
    expect(seen).toHaveLength(2);
    const agent = seen[0]!;
    expect(agent.well).toBe("mother");
    expect(agent.unit).toContain("Description=Well service: agent");
    expect(agent.unit).toContain("EnvironmentFile=/etc/well/agent.env");
    expect(agent.run).toContain("exec bun run server.ts");
    expect(agent.env).toContain("PORT='8080'");
    const site = seen[1]!;
    expect(site.env).toBeNull();
    expect(site.unit).not.toContain("EnvironmentFile");
  });

  test("one poisoned def doesn't block the others", async () => {
    await persistDef("mother", "bad", def);
    await persistDef("mother", "good", def);

    const result = await applyPersistedServices("mother", async (a) => {
      if (a.id === "bad") throw new Error("ssh apply failed (exit 255)");
    });

    expect(result.applied).toEqual(["good"]);
    expect(result.failed).toEqual([
      { id: "bad", error: "ssh apply failed (exit 255)" },
    ]);
  });

  test("def with invalid env key lands in failed, not thrown", async () => {
    await persistDef("mother", "site", { ...def, env: { "BAD-KEY": "x" } });
    const result = await applyPersistedServices("mother", async () => {});
    expect(result.applied).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe("site");
    expect(result.failed[0]!.error).toContain("invalid");
  });
});
