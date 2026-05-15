import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BootGate,
  DEFAULT_BOOT_VCPU_RATIO,
  DEFAULT_MAX_CONCURRENT_BOOTS,
  bootVcpuRatio,
  maxConcurrentBoots,
  type AdmissionDeps,
} from "./admission.ts";

// One macrotask tick — long enough for the release → refreshVcpu →
// wake-waiter → waiter's while-loop chain to settle.
const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

// Static-load deps: committed vCPU and host cores are whatever we pass.
function deps(committedVcpu: number, hostCores = 8): AdmissionDeps {
  return { committedVcpu: async () => committedVcpu, hostCores: () => hostCores };
}

describe("admission env knobs", () => {
  const savedMax = process.env.WELL_MAX_CONCURRENT_BOOTS;
  const savedRatio = process.env.WELL_BOOT_VCPU_RATIO;
  afterEach(() => {
    if (savedMax === undefined) delete process.env.WELL_MAX_CONCURRENT_BOOTS;
    else process.env.WELL_MAX_CONCURRENT_BOOTS = savedMax;
    if (savedRatio === undefined) delete process.env.WELL_BOOT_VCPU_RATIO;
    else process.env.WELL_BOOT_VCPU_RATIO = savedRatio;
  });

  test("maxConcurrentBoots: default when unset", () => {
    delete process.env.WELL_MAX_CONCURRENT_BOOTS;
    expect(maxConcurrentBoots()).toBe(DEFAULT_MAX_CONCURRENT_BOOTS);
  });

  test("maxConcurrentBoots: honors a valid override", () => {
    process.env.WELL_MAX_CONCURRENT_BOOTS = "5";
    expect(maxConcurrentBoots()).toBe(5);
  });

  test("maxConcurrentBoots: rejects garbage and sub-1 values", () => {
    process.env.WELL_MAX_CONCURRENT_BOOTS = "0";
    expect(maxConcurrentBoots()).toBe(DEFAULT_MAX_CONCURRENT_BOOTS);
    process.env.WELL_MAX_CONCURRENT_BOOTS = "banana";
    expect(maxConcurrentBoots()).toBe(DEFAULT_MAX_CONCURRENT_BOOTS);
  });

  test("bootVcpuRatio: default, valid override, garbage rejection", () => {
    delete process.env.WELL_BOOT_VCPU_RATIO;
    expect(bootVcpuRatio()).toBe(DEFAULT_BOOT_VCPU_RATIO);
    process.env.WELL_BOOT_VCPU_RATIO = "1.5";
    expect(bootVcpuRatio()).toBe(1.5);
    process.env.WELL_BOOT_VCPU_RATIO = "-3";
    expect(bootVcpuRatio()).toBe(DEFAULT_BOOT_VCPU_RATIO);
  });
});

describe("BootGate — count gate", () => {
  const saved = process.env.WELL_MAX_CONCURRENT_BOOTS;
  beforeEach(() => {
    process.env.WELL_MAX_CONCURRENT_BOOTS = "2";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WELL_MAX_CONCURRENT_BOOTS;
    else process.env.WELL_MAX_CONCURRENT_BOOTS = saved;
  });

  test("admits up to the limit immediately", async () => {
    const g = new BootGate(deps(0));
    const r1 = await g.acquire("a");
    const r2 = await g.acquire("b");
    expect(g.depth().inFlight).toBe(2);
    expect(g.depth().waiting).toBe(0);
    r1();
    r2();
  });

  test("the (limit+1)th boot waits until a slot frees", async () => {
    const g = new BootGate(deps(0));
    const r1 = await g.acquire("a");
    const r2 = await g.acquire("b");
    let thirdGotIn = false;
    const p3 = g.acquire("c").then((rel) => {
      thirdGotIn = true;
      return rel;
    });
    await tick();
    expect(thirdGotIn).toBe(false);
    expect(g.depth().waiting).toBe(1);

    r1(); // free a slot
    await tick();
    expect(thirdGotIn).toBe(true);
    expect(g.depth().inFlight).toBe(2);

    (await p3)();
    r2();
  });

  test("release is idempotent — double-release doesn't over-free", async () => {
    const g = new BootGate(deps(0));
    const r1 = await g.acquire("a");
    r1();
    r1();
    r1();
    expect(g.depth().inFlight).toBe(0);
    // a fresh acquire is uncorrupted
    const r2 = await g.acquire("b");
    expect(g.depth().inFlight).toBe(1);
    r2();
  });

  test("waiters are released in FIFO order", async () => {
    const g = new BootGate(deps(0));
    const r1 = await g.acquire("a");
    const r2 = await g.acquire("b");
    const order: string[] = [];
    const pc = g.acquire("c").then((rel) => {
      order.push("c");
      return rel;
    });
    const pd = g.acquire("d").then((rel) => {
      order.push("d");
      return rel;
    });
    await tick();
    expect(order).toEqual([]);

    r1();
    await tick();
    expect(order).toEqual(["c"]);

    r2();
    await tick();
    expect(order).toEqual(["c", "d"]);

    (await pc)();
    (await pd)();
  });
});

describe("BootGate — vCPU backstop", () => {
  const saved = process.env.WELL_MAX_CONCURRENT_BOOTS;
  beforeEach(() => {
    process.env.WELL_MAX_CONCURRENT_BOOTS = "3";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WELL_MAX_CONCURRENT_BOOTS;
    else process.env.WELL_MAX_CONCURRENT_BOOTS = saved;
  });

  test("collapses the limit to 1 when committed vCPU is over the ratio", async () => {
    // 100 vCPU / 8 cores = 12.5 — well over the default ratio of 2.
    const g = new BootGate(deps(100, 8));
    const r1 = await g.acquire("a");
    expect(g.depth().limit).toBe(1);

    let secondGotIn = false;
    const p2 = g.acquire("b").then((rel) => {
      secondGotIn = true;
      return rel;
    });
    await tick();
    expect(secondGotIn).toBe(false); // parked — limit is 1 under heavy load

    r1();
    await tick();
    expect(secondGotIn).toBe(true);
    (await p2)();
  });

  test("limit returns to the static cap once load drops back under the ratio", async () => {
    let committed = 100;
    const g = new BootGate({
      committedVcpu: async () => committed,
      hostCores: () => 8,
    });
    const r1 = await g.acquire("a");
    expect(g.depth().limit).toBe(1); // over ratio

    committed = 4; // 4/8 = 0.5 — back under the ratio
    const r2 = await g.acquire("b"); // acquire refreshes the verdict
    expect(g.depth().limit).toBe(3);
    expect(g.depth().inFlight).toBe(2);
    r1();
    r2();
  });

  test("exactly at the ratio counts as over (>=)", async () => {
    // 16 / 8 = 2.0 === default ratio → backstop engages.
    const g = new BootGate(deps(16, 8));
    await g.acquire("a");
    expect(g.depth().limit).toBe(1);
  });

  test("a failed committedVcpu read disables the backstop — count gate still works", async () => {
    const g = new BootGate({
      committedVcpu: async () => {
        throw new Error("lume unreachable");
      },
      hostCores: () => 8,
    });
    const r1 = await g.acquire("a");
    expect(g.depth().limit).toBe(3); // backstop off → static cap, no block
    r1();
  });

  test("zero host cores can't divide-by-zero into a false backstop", async () => {
    const g = new BootGate(deps(100, 0));
    await g.acquire("a");
    expect(g.depth().limit).toBe(3); // cores===0 guard → backstop stays off
  });
});

describe("BootGate — depth reporting", () => {
  const saved = process.env.WELL_MAX_CONCURRENT_BOOTS;
  beforeEach(() => {
    process.env.WELL_MAX_CONCURRENT_BOOTS = "1";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WELL_MAX_CONCURRENT_BOOTS;
    else process.env.WELL_MAX_CONCURRENT_BOOTS = saved;
  });

  test("depth reflects inFlight, waiting, and the live limit", async () => {
    const g = new BootGate(deps(0));
    expect(g.depth()).toEqual({ inFlight: 0, waiting: 0, limit: 1 });

    const r1 = await g.acquire("a");
    expect(g.depth()).toEqual({ inFlight: 1, waiting: 0, limit: 1 });

    const p2 = g.acquire("b");
    await tick();
    expect(g.depth()).toEqual({ inFlight: 1, waiting: 1, limit: 1 });

    r1();
    (await p2)();
  });
});
