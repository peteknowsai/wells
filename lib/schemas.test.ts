import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  SpliteSummary,
  SpliteResource,
  SplitesListResponse,
  CheckpointResource,
} from "./schemas.ts";

describe("schemas", () => {
  test("SpliteSummary accepts a minimal valid row", () => {
    const row = {
      name: "pete",
      status: "running",
      url: null,
      ip: "192.168.64.7",
      created_at: "2026-05-06T00:00:00Z",
      last_running_at: null,
    };
    expect(Value.Check(SpliteSummary, row)).toBe(true);
  });

  test("SpliteSummary rejects invalid status", () => {
    const row = {
      name: "pete",
      status: "burning",
      url: null,
      ip: null,
      created_at: "2026-05-06T00:00:00Z",
      last_running_at: null,
    };
    expect(Value.Check(SpliteSummary, row)).toBe(false);
  });

  test("SpliteResource accepts a full row", () => {
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
    };
    expect(Value.Check(SpliteResource, r)).toBe(true);
  });

  test("SplitesListResponse wraps an array", () => {
    expect(Value.Check(SplitesListResponse, { splites: [] })).toBe(true);
    expect(Value.Check(SplitesListResponse, { splites: "no" })).toBe(false);
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
