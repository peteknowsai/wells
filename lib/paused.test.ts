import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetForTests,
  clearPaused,
  isPaused,
  listPaused,
  markPaused,
} from "./paused.ts";

afterEach(() => _resetForTests());

describe("paused state", () => {
  test("isPaused is false for unknown names", () => {
    expect(isPaused("pete")).toBe(false);
  });

  test("mark + check", () => {
    markPaused("pete");
    expect(isPaused("pete")).toBe(true);
  });

  test("clear removes the mark", () => {
    markPaused("pete");
    clearPaused("pete");
    expect(isPaused("pete")).toBe(false);
  });

  test("idempotent — double-mark is fine", () => {
    markPaused("pete");
    markPaused("pete");
    expect(listPaused()).toEqual(["pete"]);
  });

  test("clear of unknown name is a no-op", () => {
    expect(() => clearPaused("ghost")).not.toThrow();
  });

  test("listPaused returns all currently paused", () => {
    markPaused("a");
    markPaused("b");
    markPaused("c");
    clearPaused("b");
    expect(listPaused().sort()).toEqual(["a", "c"]);
  });
});
