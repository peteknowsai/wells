import { describe, expect, test } from "bun:test";
import { composeBaseUserData } from "./cloudInit.ts";

const TEMPLATE = `#cloud-config
package_update: true
packages:
  - git
runcmd:
  - echo hi
`;

describe("composeBaseUserData", () => {
  test("preserves the #cloud-config header", () => {
    const result = composeBaseUserData(TEMPLATE, ["ssh-ed25519 AAAA t"]);
    expect(result.startsWith("#cloud-config")).toBe(true);
  });

  test("adds ssh_authorized_keys at top level", () => {
    const result = composeBaseUserData(TEMPLATE, [
      "ssh-ed25519 AAAA build@wells",
    ]);
    // @ts-expect-error Bun.YAML
    const data = Bun.YAML.parse(result) as Record<string, unknown>;
    expect(data.ssh_authorized_keys).toEqual([
      "ssh-ed25519 AAAA build@wells",
    ]);
  });

  test("preserves existing keys from the template", () => {
    const result = composeBaseUserData(TEMPLATE, ["ssh-ed25519 AAAA t"]);
    // @ts-expect-error Bun.YAML
    const data = Bun.YAML.parse(result) as Record<string, unknown>;
    expect(data.package_update).toBe(true);
    expect(data.packages).toEqual(["git"]);
    expect(data.runcmd).toEqual(["echo hi"]);
  });

  test("supports multiple keys", () => {
    const result = composeBaseUserData(TEMPLATE, [
      "ssh-ed25519 AAAA k1",
      "ssh-rsa BBBB k2",
    ]);
    // @ts-expect-error Bun.YAML
    const data = Bun.YAML.parse(result) as Record<string, unknown>;
    expect(data.ssh_authorized_keys).toEqual([
      "ssh-ed25519 AAAA k1",
      "ssh-rsa BBBB k2",
    ]);
  });

  test("produces yaml that round-trips through Bun.YAML.parse cleanly", () => {
    const result = composeBaseUserData(TEMPLATE, ["ssh-ed25519 AAAA t"]);
    // @ts-expect-error Bun.YAML
    expect(() => Bun.YAML.parse(result)).not.toThrow();
  });
});
