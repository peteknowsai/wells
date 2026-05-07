import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetForTests,
  isBusy,
  listBusy,
  markIdle,
  markWorking,
} from "./cellState.ts";

afterEach(() => _resetForTests());

describe("cell working state", () => {
  test("isBusy is false for unknown names", () => {
    expect(isBusy("pete")).toBe(false);
  });

  test("markWorking + isBusy", () => {
    markWorking("pete");
    expect(isBusy("pete")).toBe(true);
  });

  test("markIdle clears", () => {
    markWorking("pete");
    markIdle("pete");
    expect(isBusy("pete")).toBe(false);
  });

  test("idempotent", () => {
    markWorking("pete");
    markWorking("pete");
    markIdle("pete");
    markIdle("pete");
    expect(isBusy("pete")).toBe(false);
  });

  test("listBusy returns currently busy names", () => {
    markWorking("a");
    markWorking("b");
    markIdle("a");
    markWorking("c");
    expect(listBusy().sort()).toEqual(["b", "c"]);
  });
});
