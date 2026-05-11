import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForDiskReleased } from "./diskReleased.ts";

// waitForDiskReleased polls lsof for a given path. Used in createWell's
// warming sequence to wait for the bundle disk to be fully released by
// VZ post-SSH-shutdown before clonefile or restart.

let dir: string | null = null;
let openProc: Subprocess | null = null;

afterEach(async () => {
  if (openProc) {
    openProc.kill();
    await openProc.exited.catch(() => {});
    openProc = null;
  }
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = null;
  }
});

async function makeFile(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "wells-disk-released-test-"));
  const path = join(dir, "disk.img");
  await writeFile(path, "test\n");
  return path;
}

describe("waitForDiskReleased", () => {
  test("returns immediately when no process holds the file", async () => {
    const path = await makeFile();
    const t0 = Date.now();
    await waitForDiskReleased(path, 5000);
    expect(Date.now() - t0).toBeLessThan(500); // 1 poll iteration
  });

  test("times out when a process keeps the file open", async () => {
    const path = await makeFile();
    // `tail -f` keeps the file open for reading.
    openProc = spawn(["tail", "-f", path], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    // Give lsof a moment to see the open handle.
    await Bun.sleep(150);
    await expect(waitForDiskReleased(path, 500)).rejects.toThrow(/still held/);
  });

  test("succeeds once the holder exits within the deadline", async () => {
    const path = await makeFile();
    openProc = spawn(["tail", "-f", path], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    await Bun.sleep(150);
    // Kill the holder after 200ms; waitForDiskReleased should see lsof
    // come back clean on a subsequent poll and return success.
    setTimeout(() => {
      openProc?.kill();
    }, 200);
    const t0 = Date.now();
    await waitForDiskReleased(path, 3000);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2000);
  });

  test("error message includes the path and timeout", async () => {
    const path = await makeFile();
    openProc = spawn(["tail", "-f", path], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    await Bun.sleep(150);
    try {
      await waitForDiskReleased(path, 300);
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(path);
      expect(msg).toContain("300");
    }
  });
});
