import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { log } from "./log.ts";

describe("log", () => {
  let captured: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    captured = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    delete process.env.SPLITES_LOG_LEVEL;
  });

  test("info writes JSON line to stderr", () => {
    log.info("hello");
    expect(captured.length).toBe(1);
    const line = captured[0]!;
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
    expect(typeof parsed.ts).toBe("string");
  });

  test("fields are merged into the JSON object", () => {
    log.warn("oops", { code: 42, who: "pete" });
    const parsed = JSON.parse(captured[0]!);
    expect(parsed.code).toBe(42);
    expect(parsed.who).toBe("pete");
    expect(parsed.level).toBe("warn");
  });

  test("debug is suppressed at default level (info)", () => {
    log.debug("verbose");
    expect(captured.length).toBe(0);
  });

  test("SPLITES_LOG_LEVEL=debug enables debug", () => {
    process.env.SPLITES_LOG_LEVEL = "debug";
    log.debug("verbose");
    expect(captured.length).toBe(1);
    expect(JSON.parse(captured[0]!).level).toBe("debug");
  });

  test("SPLITES_LOG_LEVEL=silent suppresses everything", () => {
    process.env.SPLITES_LOG_LEVEL = "silent";
    log.error("ignored");
    expect(captured.length).toBe(0);
  });

  test("SPLITES_LOG_LEVEL=warn suppresses info, allows warn", () => {
    process.env.SPLITES_LOG_LEVEL = "warn";
    log.info("info-suppressed");
    log.warn("warn-shown");
    expect(captured.length).toBe(1);
    expect(JSON.parse(captured[0]!).msg).toBe("warn-shown");
  });

  test("unknown level falls back to info", () => {
    process.env.SPLITES_LOG_LEVEL = "garbage";
    log.debug("suppressed");
    log.info("shown");
    expect(captured.length).toBe(1);
    expect(JSON.parse(captured[0]!).msg).toBe("shown");
  });
});
