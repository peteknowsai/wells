import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thawFrom, _resetThawChain } from "./thaw.ts";
import { addWell, findWell, type WellRecord } from "./registry.ts";
import { writeRuntime, defaultRuntime } from "./wellRuntime.ts";
import { PATHS } from "./state.ts";

const sampleSrc = (name: string): WellRecord => ({
  name,
  uuid: "u-" + name,
  created_at: "2026-05-10T08:00:00Z",
  cpu: 4,
  memory: "1GB",
  disk_size: "50GB",
  auth: "well",
});

interface CallLog {
  kind: string;
  args: unknown[];
  ts: number;
}

function makeStubLume(opts: { restoreDelayMs?: number; calls: CallLog[] }) {
  return {
    delete: async (..._args: unknown[]) => {},
    info: async (name: string) => {
      opts.calls.push({ kind: "info", args: [name], ts: Date.now() });
      return { name, status: "running", ipAddress: `192.168.64.${100 + opts.calls.length}` };
    },
    restoreState: async (name: string, hibernatePath: string) => {
      opts.calls.push({ kind: "restoreState", args: [name, hibernatePath], ts: Date.now() });
      if (opts.restoreDelayMs) {
        await new Promise((r) => setTimeout(r, opts.restoreDelayMs));
      }
    },
    stop: async (..._args: unknown[]) => {},
    waitForStatus: async (name: string, target: string) => {
      opts.calls.push({ kind: "waitForStatus", args: [name, target], ts: Date.now() });
    },
  };
}

describe("thawFrom", () => {
  let stateDir: string;
  let lumeDir: string;

  beforeEach(async () => {
    _resetThawChain();
    stateDir = await mkdtemp(join(tmpdir(), "wells-thaw-state-"));
    lumeDir = await mkdtemp(join(tmpdir(), "wells-thaw-lume-"));
    process.env.WELL_STATE_DIR = stateDir;
    process.env.WELL_LUME_STORAGE = lumeDir;
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(lumeDir, { recursive: true, force: true });
    delete process.env.WELL_STATE_DIR;
    delete process.env.WELL_LUME_STORAGE;
  });

  // Build a hibernated source: registry record, runtime in `hibernating`
  // state, hibernate.bin file in vm state, full bundle on disk.
  async function provisionSource(name: string): Promise<void> {
    await addWell(sampleSrc(name));
    const vm = PATHS.vmDir(name);
    await mkdir(vm, { recursive: true });
    await writeFile(PATHS.vmHibernate(name), "fake-hibernate-blob");
    const rt = defaultRuntime();
    rt.state = "hibernating";
    await writeRuntime(name, rt);
    const bundle = join(lumeDir, name);
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, "config.json"), JSON.stringify({ name, mac: "aa:bb:cc:dd:ee:ff" }));
    await writeFile(join(bundle, "nvram.bin"), "fake-nvram");
    await writeFile(join(bundle, "disk.img"), "fake-disk-content");
  }

  test("happy path — copies bundle, registers well, calls restoreState", async () => {
    await provisionSource("egg");
    const calls: CallLog[] = [];
    const lume = makeStubLume({ calls });

    const result = await thawFrom({ srcName: "egg", newName: "thaw1", lume });

    expect(result.name).toBe("thaw1");
    expect(result.uuid).toBeTruthy();
    expect(result.bundleDir).toBe(join(lumeDir, "thaw1"));
    expect(result.hibernatePath).toBe(join(lumeDir, "thaw1", "hibernate.bin"));

    // Bundle mirror was written.
    expect(await readFile(join(lumeDir, "thaw1", "disk.img"), "utf-8")).toBe("fake-disk-content");
    expect(await readFile(join(lumeDir, "thaw1", "nvram.bin"), "utf-8")).toBe("fake-nvram");
    expect(await readFile(join(lumeDir, "thaw1", "hibernate.bin"), "utf-8")).toBe("fake-hibernate-blob");

    // welld state mirrors lume's hibernate.bin.
    expect(await readFile(PATHS.vmHibernate("thaw1"), "utf-8")).toBe("fake-hibernate-blob");

    // Registry has the new well with src's sizing + auth.
    const reg = await findWell("thaw1");
    expect(reg?.cpu).toBe(4);
    expect(reg?.memory).toBe("1GB");
    expect(reg?.auth).toBe("well");

    // Lume calls fired in order: restoreState → waitForStatus → info.
    const kinds = calls.map((c) => c.kind);
    expect(kinds).toEqual(["restoreState", "waitForStatus", "info"]);
  });

  test("rejects when source isn't hibernating", async () => {
    await addWell(sampleSrc("not-hib"));
    const rt = defaultRuntime();
    rt.state = "alive_running";
    await writeRuntime("not-hib", rt);
    const calls: CallLog[] = [];
    const lume = makeStubLume({ calls });

    await expect(thawFrom({ srcName: "not-hib", newName: "x", lume }))
      .rejects.toThrow(/'alive_running'/);
    expect(calls).toHaveLength(0);
  });

  test("rejects when source's hibernate.bin is missing", async () => {
    await addWell(sampleSrc("missing-bin"));
    const rt = defaultRuntime();
    rt.state = "hibernating";
    await writeRuntime("missing-bin", rt);
    // No hibernate.bin written.
    const calls: CallLog[] = [];
    const lume = makeStubLume({ calls });

    await expect(thawFrom({ srcName: "missing-bin", newName: "x", lume }))
      .rejects.toThrow(/hibernate.bin missing/);
    expect(calls).toHaveLength(0);
  });

  test("rejects when destination name already exists", async () => {
    await provisionSource("egg");
    await addWell(sampleSrc("collision"));
    const calls: CallLog[] = [];
    const lume = makeStubLume({ calls });

    await expect(thawFrom({ srcName: "egg", newName: "collision", lume }))
      .rejects.toThrow(/already exists/);
  });

  test("serializes concurrent thaws — restoreState calls don't overlap", async () => {
    await provisionSource("egg");
    const calls: CallLog[] = [];
    // 50ms delay inside restoreState makes overlap detectable. Sequence
    // in flight timestamps would interleave if they ran concurrently.
    const lume = makeStubLume({ restoreDelayMs: 50, calls });

    const [r1, r2, r3] = await Promise.all([
      thawFrom({ srcName: "egg", newName: "a", lume }),
      thawFrom({ srcName: "egg", newName: "b", lume }),
      thawFrom({ srcName: "egg", newName: "c", lume }),
    ]);

    // All three completed.
    expect(r1.name).toBe("a");
    expect(r2.name).toBe("b");
    expect(r3.name).toBe("c");

    // Pull just the restoreState entries — they MUST be 50ms+ apart
    // (each call's body sleeps 50ms before returning, and the next can
    // only fire after the prior settles).
    const restores = calls.filter((c) => c.kind === "restoreState").sort((a, b) => a.ts - b.ts);
    expect(restores).toHaveLength(3);
    expect(restores[1]!.ts - restores[0]!.ts).toBeGreaterThanOrEqual(50);
    expect(restores[2]!.ts - restores[1]!.ts).toBeGreaterThanOrEqual(50);
  });

  test("a thrown error doesn't permanently break the chain", async () => {
    await provisionSource("egg");
    const calls: CallLog[] = [];
    const stubBase = makeStubLume({ calls });
    let throwOnce = true;
    const lume = {
      ...stubBase,
      restoreState: async (name: string, p: string) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("simulated lume crash");
        }
        return stubBase.restoreState(name, p);
      },
    };

    // First call throws.
    await expect(thawFrom({ srcName: "egg", newName: "fail", lume }))
      .rejects.toThrow(/simulated/);

    // Second call should succeed because the chain is `.catch`-shielded.
    const r = await thawFrom({ srcName: "egg", newName: "ok", lume });
    expect(r.name).toBe("ok");
  });
});
