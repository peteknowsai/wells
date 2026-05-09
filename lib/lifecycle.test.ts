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

  test("rejects status=running with ipAddress=null (the cells-team flap trigger)", () => {
    expect(() =>
      assertHibernatable("alpha", {
        name: "alpha",
        status: "running",
        ipAddress: null,
      }),
    ).toThrow(/ipAddress=null.*VZ has likely crashed/);
  });

  test("rejects status=running with ipAddress missing entirely", () => {
    expect(() =>
      assertHibernatable("alpha", { name: "alpha", status: "running" }),
    ).toThrow(/ipAddress=null/);
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

  test("error message for ipAddress=null calls out the lume crash hazard", () => {
    let msg = "";
    try {
      assertHibernatable("alpha", {
        name: "alpha",
        status: "running",
        ipAddress: null,
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("crashed lume serve");
  });
});
