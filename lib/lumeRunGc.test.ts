import { describe, expect, test } from "bun:test";
import { parseLumeRunProcesses } from "./lumeRunGc.ts";

const SAMPLE = `\
  1234   /Users/pete/.local/share/lume/lume.app/Contents/MacOS/lume run cells-1 --no-display
  5678   /Users/pete/Projects/wells/bin/lume.app/Contents/MacOS/lume serve --port 7777
  9012   /Users/pete/.local/share/lume/lume.app/Contents/MacOS/lume run pete --no-display --mount=/foo.iso
   500   bun run daemon/welld.ts
  3333   /Users/pete/.local/share/lume/lume.app/Contents/MacOS/lume run stress-1
`;

describe("parseLumeRunProcesses", () => {
  test("extracts pid + name for each lume run subprocess", () => {
    const out = parseLumeRunProcesses(SAMPLE);
    expect(out).toEqual([
      { pid: 1234, name: "cells-1" },
      { pid: 9012, name: "pete" },
      { pid: 3333, name: "stress-1" },
    ]);
  });

  test("ignores `lume serve` (different verb)", () => {
    const out = parseLumeRunProcesses(SAMPLE);
    expect(out.find((p) => p.pid === 5678)).toBeUndefined();
  });

  test("ignores non-lume processes", () => {
    const out = parseLumeRunProcesses(SAMPLE);
    expect(out.find((p) => p.pid === 500)).toBeUndefined();
  });

  test("returns empty for empty input", () => {
    expect(parseLumeRunProcesses("")).toEqual([]);
  });

  test("works with the upstream lume.app path or our hot-built bin/lume", () => {
    const both = `\
  1   /Users/pete/Projects/splites/bin/lume run alpha --no-display
  2   /Users/pete/.local/share/lume/lume.app/Contents/MacOS/lume run beta
`;
    expect(parseLumeRunProcesses(both)).toEqual([
      { pid: 1, name: "alpha" },
      { pid: 2, name: "beta" },
    ]);
  });
});
