import { describe, expect, test } from "bun:test";
import {
  buildProbeScript,
  parseProbeOutput,
  SAVE_CHECKS,
  type ValidationCheck,
} from "./imageValidation.ts";

const TEST_CHECKS: ValidationCheck[] = [
  { name: "alpha", description: "alpha desc", remoteCmd: "true" },
  { name: "beta", description: "beta desc", remoteCmd: "false" },
];

describe("buildProbeScript", () => {
  test("emits ok/fail lines per check", () => {
    const script = buildProbeScript(TEST_CHECKS);
    expect(script).toContain('"ok: alpha"');
    expect(script).toContain('"fail: alpha"');
    expect(script).toContain('"ok: beta"');
    expect(script).toContain('"fail: beta"');
  });

  test("each check is a guarded line", () => {
    const script = buildProbeScript([TEST_CHECKS[0]!]);
    // Format: ( cmd ) && echo ok: name || echo fail: name
    expect(script).toMatch(/\( true \) && echo .*ok: alpha.* \|\| echo .*fail: alpha.*/);
  });
});

describe("parseProbeOutput", () => {
  test("classifies ok and fail lines", () => {
    const out = ["ok: alpha", "fail: beta"].join("\n");
    const r = parseProbeOutput(out, TEST_CHECKS);
    expect(r.passed).toEqual(["alpha"]);
    expect(r.failed).toEqual(["beta"]);
    expect(r.missing).toEqual([]);
  });

  test("flags checks the probe didn't produce a line for", () => {
    const out = "ok: alpha\n";
    const r = parseProbeOutput(out, TEST_CHECKS);
    expect(r.passed).toEqual(["alpha"]);
    expect(r.failed).toEqual([]);
    expect(r.missing).toEqual(["beta"]);
  });

  test("ignores noise lines (banners, motd)", () => {
    const out = [
      "Welcome to Ubuntu 25.10",
      "ok: alpha",
      "Last login: ...",
      "fail: beta",
    ].join("\n");
    const r = parseProbeOutput(out, TEST_CHECKS);
    expect(r.passed).toEqual(["alpha"]);
    expect(r.failed).toEqual(["beta"]);
  });

  test("empty output → all missing", () => {
    const r = parseProbeOutput("", TEST_CHECKS);
    expect(r.missing).toEqual(["alpha", "beta"]);
    expect(r.passed).toEqual([]);
    expect(r.failed).toEqual([]);
  });
});

describe("SAVE_CHECKS list", () => {
  test("each check has unique name", () => {
    const names = SAVE_CHECKS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("includes the four critical fork-time pieces (post-cloud-init substrate)", () => {
    const names = new Set(SAVE_CHECKS.map((c) => c.name));
    expect(names.has("well-firstboot-script")).toBe(true);
    expect(names.has("well-firstboot-service")).toBe(true);
    expect(names.has("networkd-enabled")).toBe(true);
    expect(names.has("netplan-config")).toBe(true);
  });
});
