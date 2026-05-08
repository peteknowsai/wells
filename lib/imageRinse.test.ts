import { describe, expect, test } from "bun:test";
import { RINSE_SCRIPT } from "./imageRinse.ts";

describe("RINSE_SCRIPT", () => {
  test("starts with set -e for fail-fast", () => {
    expect(RINSE_SCRIPT.startsWith("set -e &&")).toBe(true);
  });

  test("clears machine-id (host + dbus copies)", () => {
    expect(RINSE_SCRIPT).toContain("rm -f /etc/machine-id /var/lib/dbus/machine-id");
  });

  test("clears ssh host keys so each fork regenerates its own", () => {
    expect(RINSE_SCRIPT).toContain("rm -f /etc/ssh/ssh_host_*");
  });

  test("clears cloud-init instance semaphores so runcmd re-fires", () => {
    expect(RINSE_SCRIPT).toContain("rm -rf /var/lib/cloud/instances/*");
  });

  test("clears /etc/.well-ready so welld's wait loop blocks until cloud-init re-runs", () => {
    expect(RINSE_SCRIPT).toContain("rm -f /etc/.well-ready");
  });

  test("truncates /etc/hostname so DHCP doesn't lease under the source's name", () => {
    expect(RINSE_SCRIPT).toContain("truncate -s 0 /etc/hostname");
  });

  test("uses sudo on every mutation", () => {
    const lines = RINSE_SCRIPT.split(" && ");
    const mutations = lines.filter((l) => l.startsWith("rm ") || l.startsWith("truncate "));
    for (const line of mutations) {
      expect(line.startsWith("sudo ") || line.includes(" sudo ")).toBe(true);
    }
  });
});
