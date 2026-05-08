import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  bundleConfigPath,
  bundleDir,
  bundleDiskPath,
  bundleNvramPath,
  lumeStorageRoot,
} from "./bundle.ts";

describe("bundle paths", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.WELL_LUME_STORAGE;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.WELL_LUME_STORAGE;
    else process.env.WELL_LUME_STORAGE = original;
  });

  test("default storage root is ~/.lume", () => {
    delete process.env.WELL_LUME_STORAGE;
    expect(lumeStorageRoot()).toBe(join(homedir(), ".lume"));
  });

  test("WELL_LUME_STORAGE overrides root", () => {
    process.env.WELL_LUME_STORAGE = "/tmp/fake-lume";
    expect(lumeStorageRoot()).toBe("/tmp/fake-lume");
    expect(bundleDir("pete")).toBe("/tmp/fake-lume/pete");
  });

  test("bundle file paths compose correctly", () => {
    process.env.WELL_LUME_STORAGE = "/tmp/fake-lume";
    expect(bundleDiskPath("pete")).toBe("/tmp/fake-lume/pete/disk.img");
    expect(bundleConfigPath("pete")).toBe("/tmp/fake-lume/pete/config.json");
    expect(bundleNvramPath("pete")).toBe("/tmp/fake-lume/pete/nvram.bin");
  });
});
