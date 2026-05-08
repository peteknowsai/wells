import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  WellSummary,
  WellResource,
  WellsListResponse,
  CheckpointResource,
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
