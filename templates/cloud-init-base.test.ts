import { describe, expect, test } from "bun:test";

describe("cloud-init-base.yaml", () => {
  test("parses, has #cloud-config header, includes the sprites preinstalled set", async () => {
    const text = await Bun.file("templates/cloud-init-base.yaml").text();
    expect(text.startsWith("#cloud-config")).toBe(true);
    // @ts-expect-error Bun.YAML is runtime-only, no type yet
    const data = Bun.YAML.parse(text) as {
      package_update?: boolean;
      packages: string[];
      runcmd: string[];
    };

    expect(data.package_update).toBe(true);
    expect(Array.isArray(data.packages)).toBe(true);
    expect(Array.isArray(data.runcmd)).toBe(true);

    // Sprites preinstalled set, apt half
    for (const pkg of [
      "build-essential",
      "git",
      "curl",
      "python3",
      "golang-go",
      "ruby-full",
    ]) {
      expect(data.packages).toContain(pkg);
    }

    // Sprites preinstalled set, runcmd half
    const cmds = data.runcmd.join("\n");
    expect(cmds).toMatch(/nodesource|nodejs/i); // Node 22 via NodeSource
    expect(cmds).toMatch(/rustup/); // Rust
    expect(cmds).toMatch(/@anthropic-ai\/claude-code/); // Claude Code
    expect(cmds).toMatch(/\.wells-base-ready/); // freeze marker
    // Must NOT call `cloud-init status --wait` from inside runcmd — that
    // recurses into cloud-init's own waiter and deadlocks first boot.
    expect(cmds).not.toMatch(/cloud-init status --wait/);

    // Tenant agent user `cell` baked in: home /cell, bash, passwordless sudo.
    expect(cmds).toMatch(/useradd -m -d \/cell -s \/bin\/bash cell/);
    expect(cmds).toMatch(/cell ALL=\(ALL\) NOPASSWD: ALL/);
    expect(cmds).toMatch(/chmod 0440 \/etc\/sudoers\.d\/cell/);
  });
});
