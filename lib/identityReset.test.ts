import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// resetWellIdentity is integration-tested live (requires a running well
// with SSH reachable). This file pins the in-guest script contract +
// the ssh subprocess shape so changes stay deliberate.
//
// Pattern matches lib/rinseWell.test.ts — source-read + assert.

async function source(): Promise<string> {
  return readFile(
    new URL("./identityReset.ts", import.meta.url).pathname,
    "utf-8",
  );
}

describe("identityReset script contract", () => {
  test("rotates hostname via hostnamectl + /etc/hostname", async () => {
    const src = await source();
    expect(src).toContain("hostnamectl set-hostname");
    expect(src).toContain("/etc/hostname");
  });

  test("rotates machine-id by removing both /etc/ and /var/lib/dbus copies", async () => {
    const src = await source();
    // Both files must be removed before systemd-machine-id-setup,
    // else DBus keeps the old ID.
    expect(src).toContain("rm -f /etc/machine-id /var/lib/dbus/machine-id");
    expect(src).toContain("systemd-machine-id-setup");
  });

  test("script uses positional arg for hostname (no shell-escape needed)", async () => {
    const src = await source();
    expect(src).toContain("NEW_HOSTNAME=$1");
    // Caller passes the name as the bash positional, NOT embedded
    // in the script body.
    expect(src).toContain("sudo bash -s ${opts.name}");
  });

  test("does NOT regen SSH host keys (deliberate scope cut for <2s target)", async () => {
    const src = await source();
    const script = src.split("const RESET_SCRIPT")[1]?.split("`")[1] ?? "";
    expect(script).not.toContain("ssh-keygen -A");
    expect(script).not.toContain("/etc/ssh/ssh_host_");
  });

  test("does NOT touch authorized_keys (pool-fill already seeded)", async () => {
    const src = await source();
    const script = src.split("const RESET_SCRIPT")[1]?.split("`")[1] ?? "";
    expect(script).not.toContain("authorized_keys");
  });

  test("script aborts on any failed step (set -e)", async () => {
    const src = await source();
    const script = src.split("const RESET_SCRIPT")[1]?.split("`")[1] ?? "";
    expect(script.trim().startsWith("set -e")).toBe(true);
  });
});

describe("identityReset ssh subprocess shape", () => {
  test("uses non-interactive, host-key-permissive SSH options", async () => {
    const src = await source();
    expect(src).toContain('"StrictHostKeyChecking=no"');
    expect(src).toContain('"UserKnownHostsFile=/dev/null"');
    expect(src).toContain('"BatchMode=yes"');
    expect(src).toContain('"LogLevel=ERROR"');
  });

  test("uses short ConnectTimeout so a dead well surfaces fast", async () => {
    const src = await source();
    expect(src).toContain('"ConnectTimeout=2"');
  });

  test("connects as ubuntu@<ip> (cloud-image default user)", async () => {
    const src = await source();
    // The cell user comes via well-firstboot.sh; identity reset
    // happens before that user is necessarily set up on adopted
    // pool members, so stay with ubuntu.
    expect(src).toContain("`ubuntu@${opts.ip}`");
  });

  test("pipes script via stdin (no script embedded as arg)", async () => {
    const src = await source();
    expect(src).toContain('stdin: "pipe"');
    expect(src).toContain("proc.stdin.write(RESET_SCRIPT)");
    expect(src).toContain("proc.stdin.end()");
  });

  test("non-zero ssh exit becomes an Error with name + stderr slice", async () => {
    const src = await source();
    expect(src).toContain("identity reset failed for");
    expect(src).toContain("ssh exit=${code}");
    expect(src).toContain("stderr.slice(0, 300)");
  });

  test("returns elapsed ms so callers can aggregate into adoption_ms", async () => {
    const src = await source();
    expect(src).toContain("const t0 = Date.now()");
    expect(src).toContain("ms: Date.now() - t0");
  });
});
