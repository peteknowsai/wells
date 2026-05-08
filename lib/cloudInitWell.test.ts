import { describe, expect, test } from "bun:test";
import { composeWellUserData } from "./cloudInitWell.ts";

const TEMPLATE = `#cloud-config
runcmd:
  - echo hello
`;

describe("composeWellUserData", () => {
  test("appends ssh_authorized_keys for ubuntu fallback", () => {
    const out = composeWellUserData(TEMPLATE, ["ssh-ed25519 AAAA test"]);
    expect(out).toContain("ssh_authorized_keys:");
    expect(out).toMatch(/ssh_authorized_keys:\n  - ssh-ed25519 AAAA test/);
  });

  test("emits write_files block with the same keys for sprite user", () => {
    const out = composeWellUserData(TEMPLATE, [
      "ssh-ed25519 AAAA one",
      "ssh-rsa BBBB two",
    ]);
    expect(out).toContain("write_files:");
    expect(out).toContain("path: /etc/sprite-authorized-keys");
    // Each key indented 6 spaces under `content: |`
    expect(out).toContain("      ssh-ed25519 AAAA one");
    expect(out).toContain("      ssh-rsa BBBB two");
  });

  test("does NOT emit a second runcmd block (would shadow the template's)", () => {
    const out = composeWellUserData(TEMPLATE, ["ssh-ed25519 AAAA test"]);
    const matches = out.match(/^runcmd:/gm) ?? [];
    expect(matches.length).toBe(1);
  });

  test("preserves the original template content", () => {
    const out = composeWellUserData(TEMPLATE, ["ssh-ed25519 AAAA test"]);
    expect(out.startsWith(TEMPLATE)).toBe(true);
  });
});
