import { describe, test, expect } from "bun:test";
import { renderUpHtml } from "./up.ts";

describe("renderUpHtml", () => {
  test("returns a self-contained HTML page with the facts visible", () => {
    const html = renderUpHtml({
      version: "1.0.0",
      wells_count: 12,
      uptime: "5h 12m",
      degraded: false,
      respawns_last_hour: 0,
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("v1.0.0");
    expect(html).toContain(">12<");        // wells count
    expect(html).toContain("5h 12m");
    expect(html).toContain("up</span>");   // status word
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link rel");
  });

  test("flips to 'degraded' label when degraded is true", () => {
    const html = renderUpHtml({
      version: "1.0.0",
      wells_count: 8,
      uptime: "2m",
      degraded: true,
      respawns_last_hour: 4,
    });
    expect(html).toContain("degraded</span>");
    expect(html).toContain("4×");
  });

  test("escapes html-special characters in inputs", () => {
    const html = renderUpHtml({
      version: "<script>alert(1)</script>",
      wells_count: 0,
      uptime: "0m",
      degraded: false,
      respawns_last_hour: 0,
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
