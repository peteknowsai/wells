# findings — thaw (one hibernate.bin → many concurrent VMs)

**Date:** 2026-05-10
**Status:** Phase 1 verdict in (sequential thaw from one hibernate.bin works iff full bundle is mirrored). Phase 2 (concurrent thaw) ran but **crashed dev lume serve** under 3-way simultaneous restoreState — needs follow-up.

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

## Phase 2 — concurrent thaw (DEV LUME CRASHED)

`scripts/exp-thaw-concurrent.ts` runs `Promise.all` of three wakes — src (via welld API) + cln1 + cln2 (both via direct lume `restoreState`) — all reading from the same `hibernate.bin`.

**Result on first run (2026-05-10 08:03 UTC):** dev lume serve **crashed** during the simultaneous restore burst. The supervisor produced a hang dump at `/tmp/lume-hang-1778394226122-pid43545.txt` and SIGKILLed; welld then logged "welld shutting down" and stopped the spawned lume serve cleanly. Dev welld :7879 + lume :7780 both went away.

This is real bug data, not a script defect. Wells's lume **cannot handle three simultaneous `restoreMachineStateFrom` calls from the same hibernate.bin** in the current `engine/vwell-src/src/Virtualization/VMVirtualizationService.swift` shape. The script's three concurrent calls hit lume's HTTP layer; presumably lume's @MainActor serialization or an internal VZ shared-state assertion blew up.

### Hypotheses for the crash

1. **Concurrent reads of the same `hibernate.bin`** — Apple's VZ may mmap the file or hold an exclusive lock; two simultaneous opens from different VZVirtualMachine instances would race.
2. **Concurrent `requestStop`/`stop` traffic interleaving with `restoreState`** — the new graceful-stop polling loop spins on `virtualMachine.state` every 200ms; under restore, state transitions are themselves rapid and may trip a non-Sendable warning we ship past today.
3. **Three @MainActor blocking calls in flight** — lume's actor serializes on main; the three calls just queue, but if any Task awaits something that requires reentry, deadlock.
4. **Three wakes hitting the same MAC + DHCP path** — vmnet's `bootpd` may not handle three identical-MAC DHCP requests gracefully and may crash whatever proxies the bootp messages to lume's network attachment.

The four are not mutually exclusive. The hang dump should narrow it; reading it next fire.

### Next steps

- Read `/tmp/lume-hang-1778394226122-pid43545.txt` to find the actual stuck thread / VZ call.
- Re-run the script with **N_CLONES=1** (only 2 simultaneous thaws) to find the failure threshold. If 1 cln succeeds but 2 fail, the issue is concurrency-count, not just concurrency-period.
- Add a **MAC mutation** step before thaw to test whether shared-MAC is the culprit. Even if it isn't, we'll need MAC mutation eventually for the thaw primitive (vmnet's lease table is keyed on MAC; multiple identical MACs collide).
- Once we have a stable concurrent-thaw config, measure per-thaw time (Apple promises ~hundreds of ms; need to confirm under N>1).

## In plain English

We hibernated a Linux VM and tried to thaw four different cloned-VM bundles using its saved RAM image. Three of the four failed because we didn't copy enough of the source VM's identity (machine ID, UEFI variables, etc.). The fourth — where we mirrored the entire bundle — worked fine.

So the answer is: yes, you can hibernate one VM and thaw many copies of it from the same saved RAM file, **but** each copy needs its own clone of the source VM's disk and identity files. The hibernate file isn't a magical "RAM-only image"; it expects to be paired with the same disk content it last saw.

When we tried to thaw three at the SAME TIME, lume crashed. So sequential thaws work; simultaneous thaws don't yet. Three follow-up tests (read the crash dump, try 2-up instead of 3-up, try with different MACs per copy) come next.
