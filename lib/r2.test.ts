import { describe, expect, test } from "bun:test";
import { checkpointKey, clientFor, deleteCheckpoint } from "./r2.ts";

describe("checkpointKey", () => {
  test("composes the canonical path", () => {
    expect(checkpointKey("pete", "1746000000000")).toBe(
      "wells/pete/checkpoints/1746000000000/disk.img",
    );
  });

  test("doesn't escape special chars (we control the well-name namespace)", () => {
    // well names are ASCII identifiers (validated at create time);
    // checkpoint ids are ms timestamps. No %-encoding needed; the test
    // protects against accidental future encoding changes.
    expect(checkpointKey("foo-bar", "42")).toBe(
      "wells/foo-bar/checkpoints/42/disk.img",
    );
  });
});

describe("clientFor", () => {
  test("constructs an S3Client with the credentials wired through", () => {
    // Construction is what we verify here — we don't make a real network
    // call. If the upstream constructor signature changes, this catches it
    // before hitting prod.
    const client = clientFor({
      endpoint: "https://example.r2.cloudflarestorage.com",
      bucket: "wells-test",
      access_key_id: "ak",
      secret_access_key: "sk",
    });
    expect(typeof client.write).toBe("function");
    expect(typeof client.file).toBe("function");
    expect(typeof client.delete).toBe("function");
  });
});

describe("deleteCheckpoint", () => {
  test("WELL_R2_RETAIN_FOREVER=1 short-circuits before any S3 work", async () => {
    // Endpoint intentionally invalid — if the env-guard didn't return early,
    // we'd attempt DNS + connect and the call would either hang or throw.
    const config = {
      endpoint: "https://nope.invalid.invalid",
      bucket: "x",
      access_key_id: "k",
      secret_access_key: "s",
    };
    const prev = process.env.WELL_R2_RETAIN_FOREVER;
    process.env.WELL_R2_RETAIN_FOREVER = "1";
    try {
      const t0 = Date.now();
      await deleteCheckpoint(config, "anywell", "1");
      expect(Date.now() - t0).toBeLessThan(50);
    } finally {
      if (prev === undefined) delete process.env.WELL_R2_RETAIN_FOREVER;
      else process.env.WELL_R2_RETAIN_FOREVER = prev;
    }
  });
});
