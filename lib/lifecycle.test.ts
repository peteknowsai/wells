import { describe, expect, test } from "bun:test";
import { assertHibernatable } from "./lifecycle.ts";

describe("assertHibernatable", () => {
  test("permits a healthy running VM (status + ipAddress both set)", () => {
    expect(() =>
      assertHibernatable("alpha", {
        name: "alpha",
        status: "running",
        ipAddress: "192.168.64.10",
      }),
    ).not.toThrow();
  });

  test("rejects null info (lume doesn't know the VM)", () => {
    expect(() => assertHibernatable("alpha", null)).toThrow(
      /lume has no record of 'alpha'/,
    );
  });

  test("rejects status=stopped", () => {
    expect(() =>
      assertHibernatable("alpha", { name: "alpha", status: "stopped" }),
    ).toThrow(/status='stopped'/);
  });

  test("rejects status=error", () => {
    expect(() =>
      assertHibernatable("alpha", { name: "alpha", status: "error" }),
    ).toThrow(/status='error'/);
  });

  test("rejects status=provisioning", () => {
    expect(() =>
      assertHibernatable("alpha", { name: "alpha", status: "provisioning" }),
    ).toThrow(/status='provisioning'/);
  });

  test("rejects status=running + ipAddress=null when caller didn't probe substrate", () => {
    expect(() =>
      assertHibernatable("alpha", {
        name: "alpha",
        status: "running",
        ipAddress: null,
      }),
    ).toThrow(/did not provide substrate confirmation/);
  });

  test("rejects status=running + ipAddress missing when caller didn't probe substrate", () => {
    expect(() =>
      assertHibernatable("alpha", { name: "alpha", status: "running" }),
    ).toThrow(/did not provide substrate confirmation/);
  });

  test("rejects status=running + ipAddress=null when substrate probe says dead", () => {
    expect(() =>
      assertHibernatable(
        "alpha",
        { name: "alpha", status: "running", ipAddress: null },
        false,
      ),
    ).toThrow(/substrate probe \(lease file \+ TCP\) failed/);
  });

  test("permits status=running + ipAddress=null when substrate probe says alive (fresh-boot lag)", () => {
    expect(() =>
      assertHibernatable(
        "alpha",
        { name: "alpha", status: "running", ipAddress: null },
        true,
      ),
    ).not.toThrow();
  });

  test("substrateAlive=true is irrelevant when status != running", () => {
    expect(() =>
      assertHibernatable(
        "alpha",
        { name: "alpha", status: "stopped" },
        true,
      ),
    ).toThrow(/status='stopped'/);
  });

  test("error message for status mismatch points toward FSM reconciliation", () => {
    let msg = "";
    try {
      assertHibernatable("alpha", { name: "alpha", status: "error" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("reconcile FSM");
  });

  test("error message for substrate-confirmed-dead calls out the lume crash hazard", () => {
    let msg = "";
    try {
      assertHibernatable(
        "alpha",
        { name: "alpha", status: "running", ipAddress: null },
        false,
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("crashed lume serve");
  });
});
