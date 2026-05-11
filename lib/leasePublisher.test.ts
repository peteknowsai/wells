import { describe, expect, test } from "bun:test";
import {
  _resetPublisherStateForTests,
  decidePublishAction,
  publisherHealth,
} from "./leasePublisher.ts";
import type { WellRuntime } from "./wellRuntime.ts";

const mkRuntime = (overrides: Partial<WellRuntime> = {}): WellRuntime => ({
  state: "alive_running",
  last_transition_at: "2026-05-11T00:00:00Z",
  last_error: null,
  hibernate_path: null,
  restore_recipe: null,
  hibernate_ready: false,
  birth_media_detached_at: null,
  steady_state_mount: null,
  ip: null,
  ...overrides,
});

describe("decidePublishAction", () => {
  test("alive_running + stamped ip + mac → publish stamped, no restamp", () => {
    const d = decidePublishAction(
      mkRuntime({ ip: "192.168.64.5" }),
      "fe:e8:4c:5d:bf:b9",
      null,
    );
    expect(d).toEqual({
      action: "publish",
      ip: "192.168.64.5",
      needsStamp: false,
    });
  });

  test("alive_running + no stamp + observed ip + mac → publish observed, needs stamp", () => {
    const d = decidePublishAction(
      mkRuntime({ ip: null }),
      "fe:e8:4c:5d:bf:b9",
      "192.168.64.10",
    );
    expect(d).toEqual({
      action: "publish",
      ip: "192.168.64.10",
      needsStamp: true,
    });
  });

  test("stamped ip wins even when observed differs — stamp is canonical", () => {
    // This is the load-bearing case: lease file says 192.168.64.10 but
    // welld's stamped knowledge says 192.168.64.5. Trust the stamp;
    // republish 192.168.64.5 and let bootpd reconcile. The whole point
    // of welld owning the invariant is that the lease file is a
    // derived artifact, not authoritative.
    const d = decidePublishAction(
      mkRuntime({ ip: "192.168.64.5" }),
      "fe:e8:4c:5d:bf:b9",
      "192.168.64.10",
    );
    expect(d).toEqual({
      action: "publish",
      ip: "192.168.64.5",
      needsStamp: false,
    });
  });

  test("alive_paused with stamped ip publishes (paused ≠ stopped — still has IP)", () => {
    const d = decidePublishAction(
      mkRuntime({ state: "alive_paused", ip: "192.168.64.7" }),
      "fe:e8:4c:5d:bf:b9",
      null,
    );
    expect(d).toMatchObject({ action: "publish", ip: "192.168.64.7" });
  });

  test("hibernating → skip (no active IP)", () => {
    const d = decidePublishAction(
      mkRuntime({ state: "hibernating", ip: null }),
      "fe:e8:4c:5d:bf:b9",
      null,
    );
    expect(d).toMatchObject({ action: "skip" });
    expect((d as { action: "skip"; reason: string }).reason).toContain(
      "hibernating",
    );
  });

  test("stopped → skip", () => {
    const d = decidePublishAction(
      mkRuntime({ state: "stopped" }),
      "fe:e8:4c:5d:bf:b9",
      "192.168.64.7",
    );
    expect(d).toMatchObject({ action: "skip" });
  });

  test("error_orphaned → skip (operator needs to clear before we republish)", () => {
    const d = decidePublishAction(
      mkRuntime({ state: "error_orphaned" }),
      "fe:e8:4c:5d:bf:b9",
      "192.168.64.7",
    );
    expect(d).toMatchObject({ action: "skip" });
  });

  test("no runtime → skip with no-runtime reason", () => {
    const d = decidePublishAction(
      null,
      "fe:e8:4c:5d:bf:b9",
      "192.168.64.7",
    );
    expect(d).toMatchObject({ action: "skip", reason: "no-runtime" });
  });

  test("alive_running + no mac → skip (defense in depth — publish requires mac)", () => {
    const d = decidePublishAction(
      mkRuntime({ ip: "192.168.64.5" }),
      null,
      null,
    );
    expect(d).toMatchObject({ action: "skip", reason: "no-mac" });
  });

  test("alive_running + mac but no ip anywhere → skip with no-ip reason", () => {
    const d = decidePublishAction(
      mkRuntime({ ip: null }),
      "fe:e8:4c:5d:bf:b9",
      null,
    );
    expect(d).toMatchObject({ action: "skip", reason: "no-ip" });
  });
});

describe("publisherHealth — initial state", () => {
  test("returns null last_publish_at + zero counts before first sweep", () => {
    _resetPublisherStateForTests();
    const h = publisherHealth();
    expect(h.last_publish_at).toBeNull();
    expect(h.considered).toBe(0);
    expect(h.published_count).toBe(0);
    expect(h.skipped_count).toBe(0);
  });
});
