import { describe, expect, test } from "bun:test";
import { RINSE_SCRIPT } from "./imageRinse.ts";

describe("RINSE_SCRIPT", () => {
  test("starts with set -e for fail-fast", () => {
    expect(RINSE_SCRIPT.startsWith("set -e &&")).toBe(true);
  });

  test("invokes cloud-init clean (the official reset)", () => {
    expect(RINSE_SCRIPT).toContain("cloud-init clean --logs --seed");
    // ...and tolerates cloud-init being missing on minimal images.
    expect(RINSE_SCRIPT).toContain("cloud-init clean --logs --seed >/dev/null 2>&1 || true");
  });

  test("manually clears /var/lib/cloud/{instances,data,sem} as belt-and-suspenders", () => {
    // cloud-init clean would do this, but it's not on every distro.
    expect(RINSE_SCRIPT).toContain("/var/lib/cloud/instances/*");
    expect(RINSE_SCRIPT).toContain("/var/lib/cloud/data/*");
    expect(RINSE_SCRIPT).toContain("/var/lib/cloud/sem/*");
  });

  test("clears machine-id (host + dbus copies) — DHCP DUID derives from this", () => {
    expect(RINSE_SCRIPT).toContain("rm -f /etc/machine-id /var/lib/dbus/machine-id");
  });

  test("clears ssh host keys so each fork regenerates its own", () => {
    expect(RINSE_SCRIPT).toContain("rm -f /etc/ssh/ssh_host_*");
  });

  test("clears systemd-networkd DHCP client state (DUID + lease cache)", () => {
    expect(RINSE_SCRIPT).toContain("/var/lib/systemd/network/*");
    expect(RINSE_SCRIPT).toContain("/var/lib/dhcp/*");
  });

  test("removes cloud-init's MAC-pinned netplan (fork has new MAC)", () => {
    expect(RINSE_SCRIPT).toContain("/etc/netplan/50-cloud-init.yaml");
    expect(RINSE_SCRIPT).toContain("/etc/netplan/00-cloud-init-fallback.yaml");
  });

  test("clears /etc/.well-ready so welld's wait loop blocks until cloud-init re-runs", () => {
    expect(RINSE_SCRIPT).toContain("rm -f /etc/.well-ready");
  });

  test("truncates /etc/hostname so DHCP doesn't lease under the source's name", () => {
    expect(RINSE_SCRIPT).toContain("truncate -s 0 /etc/hostname");
  });

  test("uses sudo on every mutation (rm, truncate, cloud-init)", () => {
    const lines = RINSE_SCRIPT.split(" && ");
    const mutations = lines.filter((l) => /^(sudo )?(rm |truncate |cloud-init )/.test(l));
    for (const line of mutations) {
      expect(line.startsWith("sudo ")).toBe(true);
    }
  });
});
