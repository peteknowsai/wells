import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { runProcWithTimeout } from "./procTimeout.ts";

// Tests use real subprocess spawn (bash sleep / true / exit-N) so the
// timeout + kill behavior is exercised against actual OS process state.
// Cheap (~50ms total per file) and avoids the mock-shaped-but-not-real
// failure mode where the timer beats the proc artificially.

describe("runProcWithTimeout", () => {
  test("returns exit code 0 for fast successful command", async () => {
    const proc = spawn(["bash", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
    const code = await runProcWithTimeout(proc, 5000, "test");
    expect(code).toBe(0);
  });

  test("returns non-zero exit code unchanged", async () => {
    const proc = spawn(["bash", "-c", "exit 42"], { stdout: "ignore", stderr: "ignore" });
    const code = await runProcWithTimeout(proc, 5000, "test");
    expect(code).toBe(42);
  });

  test("throws when process exceeds timeout", async () => {
    const proc = spawn(["bash", "-c", "sleep 5"], { stdout: "ignore", stderr: "ignore" });
    let threw = false;
    try {
      await runProcWithTimeout(proc, 200, "slow");
    } catch (e) {
      threw = true;
      expect((e as Error).message).toContain("slow");
      expect((e as Error).message).toContain("timed out after 200ms");
    }
    expect(threw).toBe(true);
  });

  test("SIGKILLs the process on timeout (drained, no zombie)", async () => {
    const proc = spawn(["bash", "-c", "sleep 5"], { stdout: "ignore", stderr: "ignore" });
    try {
      await runProcWithTimeout(proc, 100, "kill-test");
    } catch {
      // expected timeout throw
    }
    // proc.exited should already be settled after the kill-drain
    const exitCode = await proc.exited;
    // SIGKILL → typically 137 (128 + 9) on bash
    expect(exitCode).toBeGreaterThan(0);
  });

  test("description appears in the timeout error message", async () => {
    const proc = spawn(["bash", "-c", "sleep 5"], { stdout: "ignore", stderr: "ignore" });
    let msg = "";
    try {
      await runProcWithTimeout(proc, 50, "my-specific-op-name");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("my-specific-op-name");
  });

  test("process that finishes just before timeout deadline returns normally", async () => {
    const proc = spawn(["bash", "-c", "sleep 0.05; exit 7"], { stdout: "ignore", stderr: "ignore" });
    const code = await runProcWithTimeout(proc, 1000, "tight");
    expect(code).toBe(7);
  });
});
