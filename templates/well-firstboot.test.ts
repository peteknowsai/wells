import { describe, expect, test } from "bun:test";

describe("well-firstboot.sh", () => {
  test("copies authorized_keys to /cell/.ssh when cell user exists", async () => {
    const text = await Bun.file("templates/well-firstboot.sh").text();
    // .ssh dir must be cell-owned, mode 0700.
    expect(text).toMatch(/install -d -o cell -g cell -m 0700 \/cell\/\.ssh/);
    // authorized_keys must be cell-owned, mode 0600, sourced from the seed.
    expect(text).toMatch(
      /install -o cell -g cell -m 0600 "\$SEED\/authorized_keys" \/cell\/\.ssh\/authorized_keys/,
    );
    // Guard so it's a no-op if the bake didn't include the cell user.
    expect(text).toMatch(/if id cell >\/dev\/null 2>&1; then/);
  });

  test("installs the operator key for root in a wells-owned path, not /root", async () => {
    const text = await Bun.file("templates/well-firstboot.sh").text();
    // Key lives in /etc/ssh/wells-keys/root — /root is the cells agent
    // home and not wells's to depend on.
    expect(text).toMatch(
      /install -o root -g root -m 0644 "\$SEED\/authorized_keys" \/etc\/ssh\/wells-keys\/root/,
    );
    // wells must NOT write into /root/.ssh — that's cells's home.
    expect(text).not.toMatch(/\/root\/\.ssh/);
    // sshd must permit key-based root login and read the relocated file.
    expect(text).toMatch(/PermitRootLogin prohibit-password/);
    expect(text).toMatch(/AuthorizedKeysFile \/etc\/ssh\/wells-keys\/%u \.ssh\/authorized_keys/);
  });

  test("no longer creates the `well` user or its sudoers file", async () => {
    const text = await Bun.file("templates/well-firstboot.sh").text();
    expect(text).not.toMatch(/useradd/);
    expect(text).not.toMatch(/sudoers\.d\/90-well/);
    expect(text).not.toMatch(/WELL_USER/);
  });
});
