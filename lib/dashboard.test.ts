import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { invertAliasMap, renderDashboardHtml, tailLog } from "./dashboard.ts";

describe("renderDashboardHtml", () => {
  test("returns a self-contained HTML document", () => {
    const html = renderDashboardHtml();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
    // No external assets — should be one file.
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet/);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  test("polls the data endpoint", () => {
    const html = renderDashboardHtml();
    expect(html).toContain("/dashboard/data");
    expect(html).toContain("setInterval");
  });

  test("renders the section anchors the client script writes into", () => {
    const html = renderDashboardHtml();
    expect(html).toContain('id="health"');
    expect(html).toContain('id="wells-body"');
    expect(html).toContain('id="images-body"');
    expect(html).toContain('id="leases-body"');
    expect(html).toContain('id="events-body"');
    expect(html).toContain('id="updated"');
  });
});

describe("tailLog", () => {
  const cleanup: string[] = [];
  afterAll(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true });
  });

  async function fixtureDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "dashboard-tail-"));
    cleanup.push(d);
    return d;
  }

  test("returns [] for missing file", async () => {
    const lines = await tailLog("/nonexistent/path/welld.log", 10);
    expect(lines).toEqual([]);
  });

  test("returns last N lines, newest first", async () => {
    const d = await fixtureDir();
    const p = join(d, "log");
    await writeFile(p, ["one", "two", "three", "four", "five"].join("\n") + "\n");
    const lines = await tailLog(p, 3);
    expect(lines).toEqual(["five", "four", "three"]);
  });

  test("drops empty trailing newline cleanly", async () => {
    const d = await fixtureDir();
    const p = join(d, "log");
    await writeFile(p, "alpha\nbeta\n\n");
    const lines = await tailLog(p, 5);
    expect(lines).toEqual(["beta", "alpha"]);
  });

  test("returns [] for empty file", async () => {
    const d = await fixtureDir();
    const p = join(d, "log");
    await writeFile(p, "");
    const lines = await tailLog(p, 5);
    expect(lines).toEqual([]);
  });

  test("drops leading partial line when truncating past 64KiB", async () => {
    const d = await fixtureDir();
    const p = join(d, "log");
    // Build a log > 64KiB so the tail truncates. First line should be
    // dropped because the read window starts mid-line.
    const fat = "x".repeat(70_000);
    await writeFile(p, fat + "\nmiddle\nlast\n");
    const lines = await tailLog(p, 5);
    // The truncated mid-line "x..." must NOT appear; we should see at
    // least "middle" and "last" cleanly.
    expect(lines).toContain("last");
    expect(lines).toContain("middle");
    // Newest first.
    expect(lines[0]).toBe("last");
  });

  test("limit clamps even for tiny files", async () => {
    const d = await fixtureDir();
    const p = join(d, "log");
    await writeFile(p, "only-line\n");
    const lines = await tailLog(p, 10);
    expect(lines).toEqual(["only-line"]);
  });
});

describe("renderDashboardHtml images panel", () => {
  test("includes images panel + count anchor + renderImages wiring", () => {
    const html = renderDashboardHtml();
    expect(html).toContain('id="images-body"');
    expect(html).toContain('id="images-count"');
    expect(html).toContain("renderImages(d)");
    // Health-row tile shouldn't omit images.
    expect(html).toContain("tile(\"images\"");
  });
});

describe("invertAliasMap", () => {
  test("empty input → empty map", () => {
    const r = invertAliasMap({});
    expect(r.size).toBe(0);
  });

  test("single alias → target with one entry", () => {
    const r = invertAliasMap({ "ubuntu-base": "ubuntu-25.10-base" });
    expect(r.get("ubuntu-25.10-base")).toEqual(["ubuntu-base"]);
  });

  test("multiple aliases for one target stack into one array", () => {
    const r = invertAliasMap({
      "ubuntu-base": "ubuntu-25.10-base",
      "ubuntu": "ubuntu-25.10-base",
      "latest-ubuntu": "ubuntu-25.10-base",
    });
    const aliases = r.get("ubuntu-25.10-base");
    expect(aliases).toBeDefined();
    expect(aliases!.sort()).toEqual(["latest-ubuntu", "ubuntu", "ubuntu-base"]);
  });

  test("multiple targets each get their own list", () => {
    const r = invertAliasMap({
      "ubuntu-base": "ubuntu-25.10-base",
      "cell-base": "cells-fork-2026-05-12",
    });
    expect(r.size).toBe(2);
    expect(r.get("ubuntu-25.10-base")).toEqual(["ubuntu-base"]);
    expect(r.get("cells-fork-2026-05-12")).toEqual(["cell-base"]);
  });

  test("targets with no aliases don't appear in the map", () => {
    const r = invertAliasMap({ "ubuntu-base": "ubuntu-25.10-base" });
    expect(r.has("orphan-image")).toBe(false);
  });

  test("preserves insertion order of aliases per target", () => {
    const r = invertAliasMap({
      "a": "tgt",
      "b": "tgt",
      "c": "tgt",
    });
    expect(r.get("tgt")).toEqual(["a", "b", "c"]);
  });
});
