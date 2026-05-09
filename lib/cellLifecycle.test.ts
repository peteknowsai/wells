import { afterEach, describe, expect, test } from "bun:test";
import {
  applyLifecycleState,
  parseLifecycleBody,
} from "./cellLifecycle.ts";
import { _resetForTests, isBusy } from "./cellState.ts";

afterEach(() => _resetForTests());

describe("parseLifecycleBody", () => {
  test("accepts {state:'busy'}", () => {
    expect(parseLifecycleBody('{"state":"busy"}')).toEqual({
      ok: true,
      state: "busy",
    });
  });

  test("accepts {state:'idle'}", () => {
    expect(parseLifecycleBody('{"state":"idle"}')).toEqual({
      ok: true,
      state: "idle",
    });
  });

  test("rejects invalid JSON", () => {
    const r = parseLifecycleBody("not json");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("JSON");
  });

  test("rejects non-object body", () => {
    const r = parseLifecycleBody('"busy"');
    expect(r.ok).toBe(false);
    expect(r.error).toContain("object");
  });

  test("rejects unknown state", () => {
    const r = parseLifecycleBody('{"state":"working"}');
    expect(r.ok).toBe(false);
    expect(r.error).toContain("busy");
  });

  test("rejects missing state", () => {
    const r = parseLifecycleBody("{}");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("busy");
  });

  test("ignores extra fields", () => {
    expect(parseLifecycleBody('{"state":"busy","extra":1}')).toEqual({
      ok: true,
      state: "busy",
    });
  });
});

describe("applyLifecycleState", () => {
  test("busy marks well as busy", () => {
    expect(isBusy("pete")).toBe(false);
    const r = applyLifecycleState("pete", "busy");
    expect(r.busy).toBe(true);
    expect(isBusy("pete")).toBe(true);
  });

  test("idle clears busy", () => {
    applyLifecycleState("pete", "busy");
    const r = applyLifecycleState("pete", "idle");
    expect(r.busy).toBe(false);
    expect(isBusy("pete")).toBe(false);
  });

  test("repeated busy is a no-op (idempotent)", () => {
    applyLifecycleState("pete", "busy");
    applyLifecycleState("pete", "busy");
    expect(isBusy("pete")).toBe(true);
  });

  test("repeated idle is a no-op", () => {
    applyLifecycleState("pete", "idle");
    applyLifecycleState("pete", "idle");
    expect(isBusy("pete")).toBe(false);
  });

  test("idle on never-busy well is harmless", () => {
    const r = applyLifecycleState("pete", "idle");
    expect(r.busy).toBe(false);
  });
});
