import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// rinseGuest is integration-tested live (requires a running well).
// This file pins the rinse script's contract so changes to the
// in-guest cleanup commands stay deliberate.
//
// If you need to update the script, update the test too — the test
// is the contract that cells team relies on for "rinse cleans these
// specific bits". Don't loosen without flagging in cells-integration.md.

describe("rinse script contract", () => {
  test("script wipes the four substrate identity bits", async () => {
    const src = await readFile(
      new URL("./rinseWell.ts", import.meta.url).pathname,
      "utf-8",
    );
    // Each of these wipes is load-bearing for fork-time DHCP / SSH.
    expect(src).toContain("rm -rf /var/lib/systemd/network/*");
    expect(src).toContain("/etc/machine-id");
    expect(src).toContain("touch /etc/machine-id");
    expect(src).toContain("/etc/.well-ready");
    expect(src).toContain("rm -f /etc/ssh/ssh_host_*");
    expect(src).toContain("/home/ubuntu/.ssh/authorized_keys");
  });

  test("script ends with explicit success marker", async () => {
    const src = await readFile(
      new URL("./rinseWell.ts", import.meta.url).pathname,
      "utf-8",
    );
    expect(src).toContain("echo rinsed");
  });

  test("ssh subprocess wraps in a wall-clock timeout (B.0.11.b followup)", async () => {
    const src = await readFile(
      new URL("./rinseWell.ts", import.meta.url).pathname,
      "utf-8",
    );
    expect(src).toContain("runWithTimeout(proc");
    expect(src).toContain("ServerAliveInterval=10");
    expect(src).toContain("ServerAliveCountMax=2");
  });
});
