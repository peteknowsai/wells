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
});
