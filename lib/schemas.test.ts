import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  CheckpointResource,
  ExecRequest,
  NetworkPolicyRequest,
  NetworkPolicyResponse,
  NetworkRule,
  ServiceDefinition,
  WellResource,
  WellSummary,
  WellsListResponse,
} from "./schemas.ts";

describe("schemas", () => {
  test("WellSummary accepts a minimal valid row", () => {
    const row = {
      name: "pete",
      status: "running",
      url: null,
      ip: "192.168.64.7",
      created_at: "2026-05-06T00:00:00Z",
      last_running_at: null,
      wedge: "ok",
    };
    expect(Value.Check(WellSummary, row)).toBe(true);
  });

  test("WellSummary rejects invalid status", () => {
    const row = {
      name: "pete",
      status: "burning",
      url: null,
      ip: null,
      created_at: "2026-05-06T00:00:00Z",
      last_running_at: null,
      wedge: "ok",
    };
    expect(Value.Check(WellSummary, row)).toBe(false);
  });

  test("WellSummary rejects invalid wedge label", () => {
    const row = {
      name: "pete",
      status: "running",
      url: null,
      ip: null,
      created_at: "2026-05-06T00:00:00Z",
      last_running_at: null,
      wedge: "stuck",
    };
    expect(Value.Check(WellSummary, row)).toBe(false);
  });

  test("WellResource accepts a full row", () => {
    const r = {
      name: "pete",
      uuid: "u",
      status: "stopped",
      url: null,
      ip: null,
      created_at: "2026-05-06T00:00:00Z",
      last_running_at: null,
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
      disk_used_bytes: 5_500_000_000,
      wedge: "ok",
    };
    expect(Value.Check(WellResource, r)).toBe(true);
  });

  test("WellsListResponse wraps an array", () => {
    expect(Value.Check(WellsListResponse, { wells: [] })).toBe(true);
    expect(Value.Check(WellsListResponse, { wells: "no" })).toBe(false);
  });

  test("CheckpointResource shape", () => {
    expect(
      Value.Check(CheckpointResource, {
        id: "1778078165622",
        created_at: "2026-05-06T00:00:00Z",
        size_bytes: 53_687_091_200,
        physical_bytes: 5_582_876_672,
      }),
    ).toBe(true);
  });
});

describe("schemas — NetworkRule + NetworkPolicy", () => {
  test("NetworkRule accepts allow", () => {
    expect(Value.Check(NetworkRule, { action: "allow", domain: "github.com" })).toBe(true);
  });

  test("NetworkRule accepts deny", () => {
    expect(Value.Check(NetworkRule, { action: "deny", domain: "evil.com" })).toBe(true);
  });

  test("NetworkRule rejects unknown actions", () => {
    expect(Value.Check(NetworkRule, { action: "log", domain: "x.com" })).toBe(false);
    expect(Value.Check(NetworkRule, { action: "ALLOW", domain: "x.com" })).toBe(false);
  });

  test("NetworkRule requires both action and domain", () => {
    expect(Value.Check(NetworkRule, { action: "allow" })).toBe(false);
    expect(Value.Check(NetworkRule, { domain: "x.com" })).toBe(false);
    expect(Value.Check(NetworkRule, {})).toBe(false);
  });

  test("NetworkPolicyRequest accepts empty rules", () => {
    expect(Value.Check(NetworkPolicyRequest, { rules: [] })).toBe(true);
  });

  test("NetworkPolicyRequest accepts multiple rules", () => {
    expect(
      Value.Check(NetworkPolicyRequest, {
        rules: [
          { action: "allow", domain: "github.com" },
          { action: "deny", domain: "evil.com" },
        ],
      }),
    ).toBe(true);
  });

  test("NetworkPolicyRequest rejects non-array rules", () => {
    expect(Value.Check(NetworkPolicyRequest, { rules: "all" })).toBe(false);
    expect(Value.Check(NetworkPolicyRequest, { rules: null })).toBe(false);
  });

  test("NetworkPolicyRequest rejects missing rules", () => {
    expect(Value.Check(NetworkPolicyRequest, {})).toBe(false);
  });

  test("NetworkPolicyResponse accepts {accepted, enforced, rules}", () => {
    expect(
      Value.Check(NetworkPolicyResponse, {
        accepted: true,
        enforced: false,
        rules: [{ action: "allow", domain: "github.com" }],
      }),
    ).toBe(true);
  });

  test("NetworkPolicyResponse rejects missing fields", () => {
    expect(
      Value.Check(NetworkPolicyResponse, { accepted: true, rules: [] }),
    ).toBe(false);
    expect(
      Value.Check(NetworkPolicyResponse, { enforced: false, rules: [] }),
    ).toBe(false);
  });
});

describe("schemas — ServiceDefinition", () => {
  test("accepts minimal cells-shaped body (cmd + args + workdir)", () => {
    expect(
      Value.Check(ServiceDefinition, {
        cmd: "/usr/local/bin/site-server",
        args: ["--port", "8080"],
        workdir: "/cell",
      }),
    ).toBe(true);
  });

  test("accepts optional env + auto_restart", () => {
    expect(
      Value.Check(ServiceDefinition, {
        cmd: "bash",
        args: ["-lc", "echo hi"],
        workdir: "/tmp",
        env: { FOO: "bar" },
        auto_restart: true,
      }),
    ).toBe(true);
  });

  test("accepts optional user field (cells team P1.3 unblock #3)", () => {
    expect(
      Value.Check(ServiceDefinition, {
        cmd: "bash",
        args: [],
        workdir: "/cell",
        user: "cell",
      }),
    ).toBe(true);
  });

  test("rejects when args is not an array of strings", () => {
    expect(
      Value.Check(ServiceDefinition, {
        cmd: "bash",
        args: "not-array",
        workdir: "/tmp",
      }),
    ).toBe(false);
    expect(
      Value.Check(ServiceDefinition, {
        cmd: "bash",
        args: [1, 2, 3],
        workdir: "/tmp",
      }),
    ).toBe(false);
  });

  test("rejects missing required fields", () => {
    expect(Value.Check(ServiceDefinition, { cmd: "bash", args: [] })).toBe(false); // no workdir
    expect(Value.Check(ServiceDefinition, { args: [], workdir: "/tmp" })).toBe(false); // no cmd
  });
});

describe("schemas — ExecRequest", () => {
  test("accepts {command: ['bash','-lc',script]} (sprites shape)", () => {
    expect(
      Value.Check(ExecRequest, {
        command: ["bash", "-lc", "echo hi"],
      }),
    ).toBe(true);
  });

  test("accepts optional user override (operator debug path)", () => {
    expect(
      Value.Check(ExecRequest, {
        command: ["whoami"],
        user: "ubuntu",
      }),
    ).toBe(true);
  });

  test("rejects when command is not an array of strings", () => {
    expect(Value.Check(ExecRequest, { command: "bash -lc x" })).toBe(false);
    expect(Value.Check(ExecRequest, { command: [1, 2] })).toBe(false);
  });

  test("rejects when command is missing", () => {
    expect(Value.Check(ExecRequest, { user: "ubuntu" })).toBe(false);
  });
});
