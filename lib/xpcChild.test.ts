import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import {
  diffNewPids,
  filterVzXpcRows,
  findVzXpcPids,
  isPidAlive,
  killXpcChild,
  parsePsOutput,
  pidsFromRows,
  VZ_XPC_MARKER,
  waitForNewXpcChild,
} from "./xpcChild.ts";

describe("parsePsOutput", () => {
  test("parses a typical multi-line ps row set", () => {
    const out = `  123 /usr/bin/some-process arg1
  4567 /System/Library/...VirtualMachine
99999 other-thing`;
    const rows = parsePsOutput(out);
    expect(rows).toEqual([
      { pid: 123, command: "/usr/bin/some-process arg1" },
      { pid: 4567, command: "/System/Library/...VirtualMachine" },
      { pid: 99999, command: "other-thing" },
    ]);
  });

  test("skips empty lines", () => {
    expect(parsePsOutput("\n\n  123 foo\n\n")).toEqual([
      { pid: 123, command: "foo" },
    ]);
  });

  test("skips lines that don't start with a PID", () => {
    expect(parsePsOutput("header line\n 42 ok")).toEqual([
      { pid: 42, command: "ok" },
    ]);
  });

  test("skips zero / negative pids", () => {
    expect(parsePsOutput("0 init\n-1 wat\n5 real")).toEqual([
      { pid: 5, command: "real" },
    ]);
  });
});

describe("filterVzXpcRows", () => {
  test("keeps only rows whose command contains the VZ marker", () => {
    const rows = [
      { pid: 1, command: "/usr/sbin/something" },
      {
        pid: 2,
        command:
          "/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine",
      },
      { pid: 3, command: "/Applications/Some.app" },
    ];
    expect(filterVzXpcRows(rows).map((r) => r.pid)).toEqual([2]);
  });

  test("marker substring match (no regex shenanigans)", () => {
    const rows = [
      { pid: 10, command: `prefix${VZ_XPC_MARKER}suffix` },
    ];
    expect(filterVzXpcRows(rows)).toHaveLength(1);
  });

  test("empty input returns empty", () => {
    expect(filterVzXpcRows([])).toEqual([]);
  });
});

describe("pidsFromRows", () => {
  test("extracts pids in sorted order regardless of input order", () => {
    expect(
      pidsFromRows([
        { pid: 300, command: "a" },
        { pid: 100, command: "b" },
        { pid: 200, command: "c" },
      ]),
    ).toEqual([100, 200, 300]);
  });
});

describe("diffNewPids", () => {
  test("returns PIDs in after that aren't in before", () => {
    expect(diffNewPids([1, 2, 3], [1, 2, 3, 4, 5])).toEqual([4, 5]);
  });

  test("returns empty when nothing new", () => {
    expect(diffNewPids([1, 2, 3], [1, 2, 3])).toEqual([]);
    expect(diffNewPids([1, 2, 3], [])).toEqual([]);
  });

  test("returns sorted new PIDs even if after is unsorted", () => {
    expect(diffNewPids([1], [3, 5, 2])).toEqual([2, 3, 5]);
  });

  test("ignores PIDs that disappeared", () => {
    expect(diffNewPids([1, 2, 3], [2])).toEqual([]);
  });
});

describe("isPidAlive", () => {
  test("returns true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("returns false for a PID that can't exist", () => {
    // 2^31-1, well above any plausible PID on a real system
    expect(isPidAlive(2_147_483_646)).toBe(false);
  });

  test("returns true for PID 1 (launchd) — permission denied but alive", () => {
    // We can't signal pid 1 (EPERM), and `isPidAlive` treats EPERM
    // as "alive" so it doesn't false-negative on processes we don't
    // own. Asserting this contract.
    expect(isPidAlive(1)).toBe(true);
  });
});

describe("killXpcChild", () => {
  const spawned: number[] = [];

  afterEach(() => {
    // Belt-and-suspenders: any leftover child gets a hard kill.
    for (const pid of spawned) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    spawned.length = 0;
  });

  test("kills a real child process and reports success", async () => {
    const child = spawn(["sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    const pid = child.pid!;
    spawned.push(pid);
    expect(isPidAlive(pid)).toBe(true);
    const ok = await killXpcChild(pid, { timeoutMs: 2000 });
    expect(ok).toBe(true);
    expect(isPidAlive(pid)).toBe(false);
  });

  test("returns true immediately for a PID already gone", async () => {
    const child = spawn(["sleep", "0.01"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    const pid = child.pid!;
    await child.exited;
    // Now pid is dead.
    const ok = await killXpcChild(pid, { timeoutMs: 200 });
    expect(ok).toBe(true);
  });
});

describe("findVzXpcPids", () => {
  test("returns an array (may be empty) and PIDs are positive integers", async () => {
    const pids = await findVzXpcPids();
    expect(Array.isArray(pids)).toBe(true);
    for (const p of pids) {
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThan(0);
    }
  });
});

describe("waitForNewXpcChild", () => {
  test("returns null on timeout when no new XPC appears", async () => {
    // Snapshot current XPC PIDs as `before`; with no VM operations
    // happening, no new PIDs should appear in 200ms.
    const before = await findVzXpcPids();
    const newPid = await waitForNewXpcChild(before, {
      timeoutMs: 200,
      pollIntervalMs: 50,
    });
    expect(newPid).toBeNull();
  });
});
