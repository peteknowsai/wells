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

  test("emits env vars as an /etc/environment append entry", () => {
    const out = composeWellUserData(TEMPLATE, ["ssh-ed25519 AAAA test"], {
      CELLS_PROXY_SECRET: "abc123",
      OTHER: "hello world",
    });
    expect(out).toContain("path: /etc/environment");
    expect(out).toContain("append: true");
    expect(out).toContain('CELLS_PROXY_SECRET="abc123"');
    expect(out).toContain('OTHER="hello world"');
  });

  test("escapes internal quotes and backslashes in env values", () => {
    const out = composeWellUserData(TEMPLATE, ["k"], {
      VAR: 'hello "world" \\path',
    });
    expect(out).toContain('VAR="hello \\"world\\" \\\\path"');
  });

  test("rejects newlines in env values", () => {
    expect(() =>
      composeWellUserData(TEMPLATE, ["k"], { BAD: "line1\nline2" }),
    ).toThrow(/newlines/);
  });

  test("omits env block when no env vars are passed", () => {
    const out = composeWellUserData(TEMPLATE, ["k"]);
    expect(out).not.toContain("/etc/environment");
  });
});
