import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeSshControl,
  ensureSshMaster,
  sshControlArgs,
  sshControlSocket,
} from "./sshControl.ts";

describe("sshControlSocket", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-sshctrl-test-"));
    process.env.WELL_STATE_DIR = tmp;
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("path is per-well under ssh-control dir", () => {
    const sock = sshControlSocket("pete");
    expect(sock).toBe(join(tmp, "ssh-control", "pete.sock"));
  });

  test("path stays under macOS's 104-char socket limit for typical names", () => {
    // Normal stateRoot (~/.wells) + reasonable well name → way under cap.
    const sock = sshControlSocket("cells-3");
    expect(sock.length).toBeLessThan(104);
  });
});

describe("sshControlArgs", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-sshctrl-test-"));
    process.env.WELL_STATE_DIR = tmp;
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("uses ControlMaster=no — exec spawns connect to the master, don't open one", () => {
    // The master is opened by ensureSshMaster (-fN) so exec spawns
    // use the existing socket without trying to become the master.
    const args = sshControlArgs("pete");
    expect(args).toContain("ControlMaster=no");
  });

  test("ControlPath points at the well's socket file", () => {
    const args = sshControlArgs("pete");
    const path = args.find((a) => a.startsWith("ControlPath="))!;
    expect(path.endsWith("pete.sock")).toBe(true);
  });
});

describe("closeSshControl", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-sshctrl-test-"));
    process.env.WELL_STATE_DIR = tmp;
    // Pre-create the dir as the daemon would.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tmp, "ssh-control"), { recursive: true });
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("no-op when socket doesn't exist", async () => {
    await expect(closeSshControl({ name: "pete" })).resolves.toBeUndefined();
  });

  test("unlinks a leftover socket file", async () => {
    const sock = sshControlSocket("pete");
    await writeFile(sock, "");
    expect(existsSync(sock)).toBe(true);

    // No ip+keyPath → skips the `ssh -O exit` call, falls through to
    // direct unlink. Verifies the belt-and-suspenders path.
    await closeSshControl({ name: "pete" });
    expect(existsSync(sock)).toBe(false);
  });
});

describe("ensureSshMaster", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-sshctrl-test-"));
    process.env.WELL_STATE_DIR = tmp;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tmp, "ssh-control"), { recursive: true });
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("returns immediately when socket already exists", async () => {
    const sock = sshControlSocket("alreadyup");
    await writeFile(sock, "");

    const t0 = Date.now();
    await ensureSshMaster({
      name: "alreadyup",
      ip: "127.0.0.1",
      keyPath: "/dev/null",
    });
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
