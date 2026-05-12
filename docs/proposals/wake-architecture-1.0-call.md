# Wake-from-hibernate architecture — a 1.0 scope call

**Status:** ❓ Pete decision pending. Three issues surfaced 2026-05-12 22:00–22:42Z via cells team's V1.3 first-token measurement attempt. None caused by today's bounce — all pre-existing. They were dormant because no V1 metric exercised the wake path until V1.3.

## In plain English

When a well is sleeping (hibernating), waking it up is broken in two different ways, plus there's a separate bug when welld restarts. Today the cells team accidentally exercised both wake bugs at once. Their V1.3 measurement (first-token latency) doesn't actually require hibernate/wake — they found a workaround (keep all eggs hot, never let them hibernate) and V1.3 is unblocked.

But the bigger question for you: **is "wake a hibernated cell" a 1.0 promise or a 1.1 promise?** It's currently broken three ways, and fixing it is multi-day architectural work. If we drop it from 1.0, we ship in a week. If we keep it, we ship in two-plus weeks. The cells team's V1 suite doesn't need it; the only consumer that did need it is the watchdog's autosleep-then-wake-on-traffic story, which is a substrate feature, not a cells V1 acceptance gate.

This doc lays out what's actually broken, three options for what to do about it, and a recommendation.

## The three issues

### W.73 — Resurrect race after fresh lume-serve

**Symptom:** After a `launchctl kickstart` of welld, the resurrect pass (`lib/resurrect.ts`) calls `startWell` on every well whose `runtime.json` said `alive_*`. Each call returns success in <30ms (lume.start + waitForStatus(running) both fast). But the Tier-4 (cidata-mounted, no warming) VMs crash silently within seconds.

**Evidence:** 2026-05-12 22:00:32Z bounce log. Five wells "started" in 53ms total. Within ~5min lume reports them all `stopped`. Explicit `POST /v1/wells/<name>/start` afterward revives them cleanly.

**Hypothesis:** lume's `/run` HTTP endpoint kicks the VM start asynchronously. The status flips to `running` before the VM is actually stable. The supervisor sees the now-running VM but it's in some half-started state and the underlying VZ instance crashes within seconds.

**Likely fix:** Replace `waitForStatus(running)` with `waitForSshReady` (already exists in `lib/createWell.ts`). Settle the resurrect on actual reachability, not lume's optimistic status flip. ~1 day.

**Workaround until fixed:** Run `well start <name>` on each resurrected well to revive. Or destroy + recreate.

### W.74 — `wakeWell` kills siblings

**Symptom:** Waking ANY hibernated well kills EVERY OTHER running well as collateral. `lib/lifecycle.ts:346` calls `killAndRestartLumeServe()` to release VZ-internal state before `restoreState`. When lume serve dies, all VZVirtualMachine XPC children die with it.

**Evidence:** 2026-05-12 22:22:30Z cells team waked egg-81256d → killAndRestart killed pids 66020 → 93832. The 10 just-refilled wells in the pool went dead as collateral.

**Hypothesis (well-documented in code):** Apple's `Virtualization.framework` keeps internal kernel-level state keyed by disk path. A fresh `VZVirtualMachine` inherits the saved `.paused` state and `restoreMachineStateFrom` errors. Process termination is currently the only known way to fully release. Source: `engine/vwell-src/` lume soft fork; B.0.9.d.4.e plan documented this.

**Likely fix:** Hard. Two paths:
- (a) Find a programmatic VZ-state-release that doesn't require killing the process. Maybe a private API or Apple framework version that exposes a release hook we don't know about. Research project — could be days of trying.
- (b) Move to Apple's `containerization` framework when it matures. Currently has no save/restore API per `docs/ROADMAP.md`. Not on the table.
- (c) Pre-hibernate every running well before waking one, then re-wake them after. ~10s per well × pool depth × 2 = 1+ minute for a single wake. Defeats the wake performance promise.

### W.75 — `restoreState` 400 even with byte-identical configs

**Symptom:** Even after the kill-restart cleared the deck, `lume.restoreState(egg-81256d, hibernate.bin)` returned `400 "Invalid virtual machine configuration. The storage device attachment is invalid."`

**Evidence:** Save-time config and restore-time config snapshots are byte-identical for the storage device:

```
"VZVirtioBlockDeviceConfiguration(path=/Users/pete/.lume/egg-81256d/disk.img,
 readOnly=false,caching=2,sync=2)"
```

Same path. Same caching mode. Same sync. Yet VZ refused.

**Hypothesis (one of):**
- VZ kernel state from the just-killed lume serve wasn't fully released 14ms later when `restoreState` fired. Race between kill-restart-restore.
- The disk file on disk changed between save and restore (e.g., the welld bounce caused a touch that altered ctime, which VZ's content-hash check rejected).
- An undocumented VZ-internal version field changed across lume serve PIDs.

**Likely fix:** Real investigation needed. ~1-3 days minimum. Each hypothesis above needs probing. Could need lume's Swift sources patched to add settling-delay-or-retry. Could need a different save format. Could be unfixable without Apple's help.

**Note:** This is NOT the cidata-attached bug from B.0.9.d.2. That's solved (warming sequence detaches cidata; the saved-state config above shows only one storage device). This is a different mismatch.

## Three options

### Option A — Fix all three, ship 1.0 with wake-from-hibernate working

**Scope:** W.73 + W.74 + W.75 all fixed before 1.0 cut.

**Effort:** 4–8 days, mostly W.74 + W.75 research. W.73 is a known fix.

**Risk:** W.74 might be unfixable without Apple framework work we can't do. Could become a black hole.

**Trade-off:** Highest substrate completeness. Latest 1.0 ship date. Risk of indefinite slip on W.74.

### Option B — Drop wake-from-hibernate from 1.0 contract

**Scope:** Disable hibernate at the daemon level for 1.0. Watchdog stops hibernating wells (revert to the autosleep mitigation cells team's been using with `auto_sleep_seconds=null`). `well hibernate` / `well wake` CLI commands stay (don't break the API surface) but no production path triggers them. Fix W.73 (cheap, helps any restart path). Document W.74 + W.75 as known issues with a 1.1 plan.

**Effort:** 1–2 days. W.73 fix, daemon hibernate-disabled toggle, docs.

**Risk:** Low. The contract becomes "wells are either alive or destroyed; no hibernate tier in 1.0." Cells team is already running with `auto_sleep_seconds=null` per the wake-regression mitigation, so this matches their actual usage.

**Trade-off:** Loses the headline "100s of cells per Mac mini" memory-pressure story for 1.0. Not a V1-acceptance blocker — cells team's V1 doesn't measure or exercise the autosleep path.

### Option C — Hybrid: hibernate code stays, autosleep disabled in defaults

**Scope:** Keep `lib/lifecycle.ts:hibernateWell` and `wakeWell` in the codebase (their unit tests pass; the code paths work in narrow conditions — single-well-at-a-time, no parallel pool). Set `defaults.auto_sleep_seconds = null` in `lib/defaults.ts`. Watchdog reads the default and skips the hibernate tick. Operators can still `well hibernate <name>` manually if they want, accepting the W.74 sibling-kill collateral (documented in CLI help). Fix W.73. Document W.74 + W.75 as known issues.

**Effort:** 1 day. Default flip, watchdog gating, W.73 fix, docs.

**Risk:** Lowest. Same as Option B in practice (no production path triggers wake), but keeps the code alive for the post-1.0 work.

**Trade-off:** Subtly different from Option B — same shipped behavior, but the code stays warm and 1.1 has less reinstatement work.

## Recommendation

**Option C, hybrid.** Reasoning:

1. **Cells V1 doesn't require wake-from-hibernate.** V1.10 is pool burst (no wake). V1.3 is first-token from a hot egg (no wake — they've already pivoted to claim-hot, and "Pass 1 short-circuits on cold=0" sidesteps wake permanently). Other V1 metrics are steady-state or fresh-create. Wake is a 1.1 feature, not 1.0.

2. **Operators don't need wake in 1.0.** The "many idle cells per Mac" story works fine with destroy + recreate, given the 14-17s fresh-create cost. Operators with that workload are 1.x. Pete's solo-developer workflow doesn't exercise the pool ceiling.

3. **The fix is genuinely multi-day research.** W.74 may need Apple's help or a different framework. Pinning the 1.0 ship date to a research problem is high-risk.

4. **Option C preserves optionality.** Code stays. Tests stay. 1.1 picks up the W.74/W.75 fix as a focused project. No code rip-out.

5. **W.73 ships either way** — it's cheap, it improves any cold-restart path (which IS in 1.0).

If Option C, then the 1.0 ship date stays roughly where road-to-wells-1.0.html has it (~2026-06-06), V1.3 unblocks immediately, and 1.1 gets a clean "wake-from-hibernate" milestone with the right amount of research budget.

## What changes if Option C

`lib/defaults.ts` — flip `auto_sleep_seconds: 60` → `null`. Confirm `lib/watchdog.ts` honors null as "never hibernate" (it already does per `feedback_decision_ownership` memory — that's the cells team mitigation that's been in place since the wake regression).

`cli/well.ts` — `well hibernate <name>` help text gains "⚠️ Experimental in 1.0 — wakes will kill sibling wells. See known issues."

`docs/lifecycle.md` — add a "1.0 scope" callout. Hibernating tier is implemented but the wake path has known bugs; production should treat 1.0 as "alive or destroyed." 1.1 fixes wake.

`docs/proposals/road-to-wells-1.0.html` — add Phase 6 (1.1) outline: A.2 Frozen tier was already deferred; add "wake-from-hibernate" as the second 1.1 work item.

`docs/proposals/wake-from-hibernate-1.1.md` — new doc, the plan for 1.1's research project on W.74 + W.75. Includes lessons learned from today.

W.73 fix as a normal small commit. Probably ~1 day including tests.

## Open questions for Pete

1. **Option A/B/C?** (Recommendation: C.)
2. **If C: should `well hibernate <name>` stay reachable from the CLI with a warning, or be hidden behind a `--experimental` flag?**
3. **If C: should the daemon refuse `POST /v1/wells/<name>/hibernate` outright (4xx), or accept it with the documented sibling-kill collateral?** Affects whether cells team can still trigger it accidentally.
4. **1.1 timing — is wake-from-hibernate the priority 1.1 feature, or does A.2 Frozen tier come first?** (A.2 needs wake to work end-to-end, so they're related.)

## Cross-references

- `BOARD.md` — W.73 logged 2026-05-12 22:30Z
- `docs/proposals/road-to-wells-1.0.html` § 6 — Definition of done (would update with Option C)
- `docs/lifecycle.md` — would gain the 1.0 scope callout
- `lib/lifecycle.ts:346` — the killAndRestartLumeServe call (W.74 site)
- `lib/resurrect.ts` — the W.73 race site
- `engine/vwell-src/` — the wells-owned lume soft fork (where W.74/W.75 fix work would live if we try Option A)
- Wells↔cells chat 2026-05-12 22:00–22:53Z for the original surfacing
