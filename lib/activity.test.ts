import { describe, expect, test } from "bun:test";
import { countTcpToIp, sampleActivity, type LsofRunner } from "./activity.ts";

// lsof field-output: one record per connection, fields prefixed by letter.
// The `n` field holds the 4-tuple. Real example for an established ssh
// connection: `n10.0.0.1:54321->192.168.64.7:22`.
function fakeLsof(records: string[]): string {
  return records.map((tuple) => `n${tuple}`).join("\n") + "\n";
}

describe("countTcpToIp", () => {
  test("returns 0 when lsof has no matching connections", async () => {
    const runner: LsofRunner = async () => "";
    expect(await countTcpToIp("192.168.64.7", 22, runner)).toBe(0);
  });

  test("counts ssh connections", async () => {
    const runner: LsofRunner = async () =>
      fakeLsof([
        "10.0.0.1:54321->192.168.64.7:22",
        "10.0.0.2:54322->192.168.64.7:22",
      ]);
    expect(await countTcpToIp("192.168.64.7", 22, runner)).toBe(2);
  });

  test("counts all TCP when port is null", async () => {
    const runner: LsofRunner = async () =>
      fakeLsof([
        "10.0.0.1:54321->192.168.64.7:22",
        "10.0.0.2:9999->192.168.64.7:8080",
        "10.0.0.3:11111->192.168.64.7:443",
      ]);
    expect(await countTcpToIp("192.168.64.7", null, runner)).toBe(3);
  });

  test("forwards the right -i filter for port-scoped queries", async () => {
    let captured = "";
    const runner: LsofRunner = async (args) => {
      const i = args.indexOf("-i");
      captured = args[i + 1] ?? "";
      return "";
    };
    await countTcpToIp("192.168.64.7", 22, runner);
    expect(captured).toBe("TCP@192.168.64.7:22");
    await countTcpToIp("192.168.64.7", null, runner);
    expect(captured).toBe("TCP@192.168.64.7");
  });

  test("only counts ESTABLISHED — passes the -sTCP filter", async () => {
    let saw = false;
    const runner: LsofRunner = async (args) => {
      saw = args.includes("-sTCP:ESTABLISHED");
      return "";
    };
    await countTcpToIp("192.168.64.7", 22, runner);
    expect(saw).toBe(true);
  });
});

describe("sampleActivity", () => {
  test("idle — both probes return zero", async () => {
    const runner: LsofRunner = async () => "";
    const sample = await sampleActivity("192.168.64.7", runner);
    expect(sample).toEqual({
      sshConnections: 0,
      anyTcpConnections: 0,
      isActive: false,
    });
  });

  test("ssh-only — one ssh connection, no other ports", async () => {
    const runner: LsofRunner = async (args) => {
      const i = args.indexOf("-i");
      const filter = args[i + 1] ?? "";
      // ssh probe filters by port 22; any-tcp probe doesn't.
      if (filter.endsWith(":22")) {
        return fakeLsof(["10.0.0.1:54321->192.168.64.7:22"]);
      }
      return fakeLsof(["10.0.0.1:54321->192.168.64.7:22"]);
    };
    const sample = await sampleActivity("192.168.64.7", runner);
    expect(sample.sshConnections).toBe(1);
    expect(sample.anyTcpConnections).toBe(1);
    expect(sample.isActive).toBe(true);
  });

  test("non-ssh activity — proxied web request", async () => {
    const runner: LsofRunner = async (args) => {
      const i = args.indexOf("-i");
      const filter = args[i + 1] ?? "";
      if (filter.endsWith(":22")) return "";
      return fakeLsof(["1.2.3.4:5555->192.168.64.7:8080"]);
    };
    const sample = await sampleActivity("192.168.64.7", runner);
    expect(sample.sshConnections).toBe(0);
    expect(sample.anyTcpConnections).toBe(1);
    expect(sample.isActive).toBe(true);
  });
});
