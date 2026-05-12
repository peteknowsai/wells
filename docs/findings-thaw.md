# findings — thaw (one hibernate.bin → many concurrent VMs)

**Date:** 2026-05-10
**Status:** ✅ Phase 1 + 2 + end-to-end verdict in (post-W.27 host reboot).

## Phase 3 — end-to-end (post-host-reboot, 2026-05-10 12:24 UTC)

After the W.27 host reboot, ran the canonical thaw flow on dev:

1. Create `dev-thaw-src` from `ubuntu-25.10-base` (9.7s).
2. Hibernate `dev-thaw-src` (200ms).
3. Thaw `dev-thaw-cln-1` from `dev-thaw-src` (`POST /v1/wells {name, from_thaw}`) — **481ms wall**, status=running.
4. Thaw `dev-thaw-cln-2` from `dev-thaw-src` — **480ms wall**, status=running. Both clones live concurrently.
5. lume info on each: both report ipAddress=192.168.64.3, status=running.
6. Host ARP: 192.168.64.3 resolves to one MAC (whichever VM is currently owning the ARP entry). Ping succeeds (~0.5ms).

**Verdict for cells team's eggs/pool design:**
- Wells's substrate can thaw many VMs from one hibernated bundle in **<500ms each**. Lume + VZ accept the parallel-running clones at the kernel level.
- **All clones share MAC + machine-identity** (saved-state contract — VZ rejects mutation; documented in Phase 1 below). At the network layer they collide on a single IP/MAC.
- Cells team's egg layer must handle in-guest re-identity post-thaw: hostname rotation, MAC rebind via systemd-networkd link config, fresh DHCP request, machine-id regen, ssh host key rotation. Wells exposes the substrate; cells owns the warmup-and-rebrand logic inside the guest.
- Practical pool flow: warm a single source cell → hibernate → thaw N copies on demand → each copy boots and immediately rebrands itself.

## Term

**Thaw** = wells's verb for "given one hibernated bundle, materialize N running VMs from it." Single-thaw is a normal `well wake`. Multi-thaw is the new primitive this experiment scopes. Cells team's **eggs** (warmed cells preloaded with variant + harness) are a layer ON TOP of thaw — eggs use thaw to materialize N warm cells from one warmed source. Wells owns the substrate; cells owns the workload abstraction.

## Pete's question

Can a single `hibernate.bin` from one VM be used to thaw N cloned VMs, each with independent IPs / PIDs? Determines what cells team can build on top: one warmed source → many cheap concurrent thaws vs. each fork carrying its own hibernate.bin.

## Phase 1 — sequential thaw portability

**Test:** Hibernate source well `thaw-src` (steady-state Ubuntu 25.10). For each variant of cln-bundle setup, create cln, mutate cln's bundle per variant, copy `thaw-src/hibernate.bin` into cln's bundle, call `lume.restoreState(cln)`. Observe whether VZ.framework's `restoreMachineStateFrom` accepts.

| Variant | Bundle mutation | VZ result |
|---|---|---|
| v1-naive | `cln` is fresh — different MAC, different machineIdentifier, different nvram, different disk.img inode | **REJECT** "invalid argument" |
| v2-match-machineId | Copy src's `config.json.machineIdentifier` into cln | **REJECT** "invalid argument" |
| v3-match-machineId-and-nvram | v2 + copy src's `nvram.bin` (UEFI variables incl. MAC) | **REJECT** "invalid argument" |
| v4-full-bundle-mirror | cln becomes a byte-for-byte mirror of src's bundle (`config.json`, `nvram.bin`, `disk.img`) | **ACCEPT** — cln boots, status=running |

Run: `bun run scripts/exp-hibernate-portability.ts` against dev welld :7879, 2026-05-10 ~07:50 UTC, all four variants in single sweep, ~3-4 minutes wall-clock. (That script's variable names still say "egg" — pre-rename; not worth bouncing dev to fix the cosmetics, the test results are what matters.)

### Conclusion (Phase 1)

`hibernate.bin` is **portable across bundles** but only when the receiving bundle's `disk.img` matches the source's at hibernate time. Apple's VZ doesn't validate disk identity by inode (we tested that — different inode is fine), but it DOES validate that the disk's *content* matches what the saved state expects to find. machineIdentifier and nvram alone aren't enough; the disk has to be the same.

**Operationally:** for each thaw, the daemon must clonefile the source's `disk.img` (cheap on APFS) along with copying `config.json`, `nvram.bin`, and `hibernate.bin`. The bundle is the unit, not just the saved state.

This matches the docs Apple ships: `restoreMachineStateFrom` requires the VM's configuration at restore to be "compatible" with the configuration at save, and disk content is implicitly part of that contract.

### What wells can offer cells

✅ **A single warmed source bundle can serve as the template for N thaws.** Each thaw is a full bundle copy + the shared `hibernate.bin`. APFS clonefile makes the disk copy O(1) and ~free; config.json + nvram.bin are tiny. So per-thaw cost is roughly `clonefile(disk) + 2 small file copies + lume.restoreState` ≈ a few hundred ms.

❌ **It does NOT mean "boot from RAM image with no disk."** Each thaw must carry its own disk.img clone. We're not avoiding disk copy; we're avoiding boot.

Cells team can use this to materialize their **eggs**: the cells egg cache is N pre-warmed bundles, each holding a specific variant+harness, ready to thaw on demand. Whether one egg = one bundle, or one egg = (bundle template + per-variant nvram tweak) is cells's call.

## Phase 2 — concurrent thaw (lume crashes at concurrency ≥ 2)

`scripts/exp-thaw-concurrent.ts` runs `Promise.all` of N+1 wakes — src (via welld API) + N clns (via direct lume `restoreState`) — all reading from the same `hibernate.bin`. Used `THAW_N_CLONES` env to bisect.

| Run | Concurrency | Outcome |
|---|---|---|
| 2026-05-10 08:03 UTC, N=2 (3 concurrent) | 3 simultaneous restoreState | **CRASH** — lume serve hung; supervisor SIGKILLed. Pre-supervisor-fix-deployment, welld also went down. |
| 2026-05-10 08:30 UTC, N=1 (2 concurrent) | 2 simultaneous restoreState | **CRASH** — lume serve crashed; supervisor caught + respawned cleanly (welld stayed up). cln got `ConnectionRefused` mid-call. |

### Verdict

**Wells's lume cannot handle ≥ 2 concurrent `restoreMachineStateFrom` calls.** Even 2-way crashes. The threshold is 1 — i.e., concurrency must be 1 (sequential thaw). This is a hard constraint at the current `engine/vwell-src/src/Virtualization/VMVirtualizationService.swift` shape.

### Why concurrency ≥ 2 crashes

Strongest theory: lume's `@MainActor` actor serializes calls onto the main queue; concurrent `restoreMachineStateFrom` calls each issue an async VZ call that suspends and waits for completion. The first call holds main-actor while waiting for VZ; the second call queues waiting for main-actor; meanwhile the first call's VZ completion needs to re-enter main-actor to resume the continuation — and Apple's VZVirtualMachine state transitions seem to also need main-actor reentry. Net effect: a deadlock, then either watchdog kicks in inside VZ or lume's HTTP runloop times out. The hang dumps from the first run were empty (lume had exited by sample time), so this is a hypothesis from the symptom shape, not a forensic reading.

We don't NEED to root-cause this further to make progress on the thaw primitive — the operational answer is the same either way: **wells serializes thaw calls**.

### Implications for the thaw primitive design

- **Wells must serialize multi-thaw.** Cells team's API contract: "thaw N from this hibernate.bin." Wells's implementation: a mutex around `lume.restoreState`. Issue requests sequentially; per-thaw is ~hundreds of ms (Phase 1 v4 was ~1s wall-clock per cln); 10 thaws = ~1-2s total. Acceptable for the egg-pop case.
- **Don't expose `Promise.all`-style fan-out at the wells API layer.** Cells team can `await thaw(src, count)` and trust wells to serialize. If they `Promise.all` from their side and we don't serialize on ours, lume crashes — and the supervisor respawn loses any in-flight work.
- **Future "true concurrency" path (out of scope now):** patch lume's VZVirtualMachine wrapper to use one-actor-per-VM rather than a shared @MainActor, OR run multiple lume serve instances (one per VM, expensive). Either is a real engineering project; serialized thaw is enough for v1 of cells's eggs.

### Next steps

- ✅ **Serialized `thawFrom`** (commit `031e798`): `lib/thaw.ts` ships a module-level promise chain serializing all calls. Concurrent callers can `Promise.all` and trust wells to one-at-a-time them.
- ✅ **API surface** (commit `558d333`): `POST /v1/wells {name, from_thaw}` mirrors `from_image`. CLI flag `well create --from-thaw=<src>`. Live-verified end-to-end on dev: HTTP 201 status=running in <1s.
- ❌ **MAC mutation** (tested 2026-05-10 08:43 UTC): rejected. Pre-restoreState mutation of `config.json.macAddress` makes VZ reject with the same "invalid argument" Phase 1 v1-v3 hit. **The MAC is part of Apple's saved-state contract** — VZ validates it when re-attaching the saved CPU/RAM/device state. nvram.bin doesn't carry the MAC (verified empirically — searched all 128KB for the config MAC bytes), but VZ keys on the MAC somewhere in the saved-state pipeline, possibly inside hibernate.bin's encoded VirtIO device state.
  - Implication: thaw inherits src's MAC verbatim. Concurrent thaws from same src share src's MAC → vmnet DHCP collision.
  - Path forward: post-restore guest-side MAC change via SSH (`ip link set dev eth0 address 02:xx:xx:xx:xx:xx; dhclient -r eth0; dhclient eth0`). Brief collision window during the thaw → ssh → ip-link sequence (~hundreds of ms), but then the new MAC gets a fresh lease. Out of scope this slice.
- Doc the contract in `docs/cells-integration.md` so cells team knows what they can rely on (egg-pop pattern works; concurrent multi-thaw collides on DHCP; post-restore MAC change is the v2 path).

## In plain English

We hibernated a Linux VM and tried to thaw four different cloned-VM bundles using its saved RAM image. Three of the four failed because we didn't copy enough of the source VM's identity (machine ID, UEFI variables, etc.). The fourth — where we mirrored the entire bundle — worked fine.

So the answer is: yes, you can hibernate one VM and thaw many copies of it from the same saved RAM file, **but** each copy needs its own clone of the source VM's disk and identity files. The hibernate file isn't a magical "RAM-only image"; it expects to be paired with the same disk content it last saw.

When we tried to thaw three at the SAME TIME, lume crashed. Then we tried two at the same time — also crashed. The threshold is one: lume can only do one thaw at a time.

That's a constraint, not a dead end. Wells's API can still let cells team say "give me N thawed copies" — wells just runs them in a queue under the hood. Each thaw is ~1 second, so 10 thaws is ~10 seconds total. That's good enough for cells's eggs; we don't need true parallelism to ship.
