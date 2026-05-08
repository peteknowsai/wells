import { describe, expect, test } from "bun:test";
import { checkpointKey, clientFor } from "./r2.ts";

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
