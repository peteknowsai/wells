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

  test("optional firstboot artifacts get embedded as write_files", () => {
    const result = composeBaseUserData(TEMPLATE, ["ssh-ed25519 AAAA t"], {
      shellScript: "#!/bin/bash\necho hi\n",
      serviceUnit: "[Unit]\nDescription=test\n",
    });
    // @ts-expect-error Bun.YAML
    const data = Bun.YAML.parse(result) as Record<string, unknown>;
    const files = data.write_files as Array<{ path: string; content: string }>;
    expect(files).toHaveLength(2);
    expect(files[0]!.path).toBe("/usr/local/sbin/well-firstboot");
    expect(files[0]!.content).toContain("#!/bin/bash");
    expect(files[1]!.path).toBe(
      "/etc/systemd/system/well-firstboot.service",
    );
    expect(files[1]!.content).toContain("[Unit]");
  });

  test("absent firstboot keeps user-data unchanged from base behavior", () => {
    const result = composeBaseUserData(TEMPLATE, ["ssh-ed25519 AAAA t"]);
    expect(result).not.toContain("write_files");
  });
});
