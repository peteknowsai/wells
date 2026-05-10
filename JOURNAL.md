# splites — Journal

Append-only. Each entry: `## YYYY-MM-DD HH:MM UTC — <author> — <task>`. Authors: `pete-session`, `worker`, `steward`.

---

## 2026-05-10 09:50 UTC — worker — no-op iters 23-123 (still blocked on Pete)

Same blockers as iter 22. Folding consecutive no-op iters into one entry to reduce JOURNAL/git churn.

---

## 2026-05-10 09:48 UTC — worker — no-op (queue exhausted, blocked on Pete decisions)

Iter 22. All pickable Todos blocked on Pete:
- W.27 (wake regression) — needs host reboot or stable wake-test
- W.2 (R2 round-trip smoke) — needs bucket-scoped R2 token
- W.22 (steward starvation) — architectural decision

Wake-dependent items (W.10, W.11, W.26 thaw end-to-end) all gated on W.27.

Iters 16-21 cleared low-priority cleanup: live-verified W.23 pool zombie auto-prune + W.25 images shape tolerance, refreshed STATUS.md, fixed wake-stress smoke fail-fast, added W.27 error-message variance to the regression doc, pruned 4 orphan lume bundles. 532/532 green.

Loop continues with the safety cap (MAX_ITER=200); future fires will likely no-op until Pete returns.

---

## 2026-05-10 09:36 UTC — worker — fires 3-15 cluster (thaw shipped, perf verified, wake regression surfaced)

Pete Loop fires 3-15, ~90 minutes of work. Twelve commits across W.26 (thaw), W.7 (perf verify), W.13 (concurrent-fork ceiling), W.27 (wake regression diagnosis), W.2 (R2 smoke fix), and the cells-integration doc refresh.

**Thaw primitive (W.26)** shipped end-to-end:
- `lib/thaw.ts` — `thawFrom(srcName, newName)` serialized through a module-level promise chain (concurrent callers can `Promise.all` and trust wells to one-at-a-time them through lume).
- `POST /v1/wells {name, from_thaw}` + `well create --from-thaw=<src>` mirror the existing `from_image` shape.
- Bundle materialization: copy src's config.json, nvram.bin, disk.img, hibernate.bin, AND **hibernate.config.json** (with path-rewrite from src's name → cln's name; JSON has escaped slashes so cover both `/<src>/` and `\/<src>\/` forms).
- Dropped MAC mutation — VZ rejects "invalid argument" if config.json's macAddress differs from src at restoreState. MAC is part of the saved-state contract, full bundle mirror is the only accepted shape.
- Fire 5's first thaw worked end-to-end (HTTP 201 + status running). Subsequent attempts hit the wake regression (W.27).

**W.7 perf verify** (post-graceful-stop, post-W.21 DHCP poll): generated 5 fresh creates, ran the analyzer across 125 samples (74 stable + 51 dev). Total p95 dropped 27.1s → 17.4s (-36%); diskReleased p95 6.4s → 4.5s (-30%); both W.7 sysrq-s and W.21 DHCP-poll-tightening shipped real wins, no regression.

**W.13 concurrent-fork ceiling**: tested N=2-6 on dev. Lume itself is stable at all tested N (PID never changed, zero respawns). Failure mode is vmnet bootpd DHCP race: N≤4 all succeed cleanly, N=5 has 1 timeout, N=6 has 2 timeouts. Cells team can fan-out up to 4 concurrent fresh-creates without mitigation.

**W.27 wake regression** (active blocker): every `well wake` / `from_thaw` / `lume.restoreState` returns VZ "permission denied" inside Apple's framework, after lume's diagnostic checks pass. Last known good wake at 04:02 UTC. Bisected the graceful-stop hypothesis live (revert + rebuild + smoke) — still fails, so graceful-stop is innocent. Issue is below us in the stack (Apple VZ daemon, TCC, or accumulated lume process state). Recipe documented in `docs/findings-wake-regression-permission-denied.md`; recommended next step is a host reboot (Pete-driven). Reverting graceful-stop has no benefit and would re-break cells's bake.

**W.2 R2 smoke fix**: bisected the create timeout — `disk: "10GB"` was truncating the cloned 50GB ext4 mid-structure, breaking guest boot before DHCP. Dropped the disk override. Smoke now passes [1/7]. Next blocker is `Access Denied` on the wells-smoke-r2 bucket — Cloudflare token-permissions fix Pete needs to mint.

**Cells team docs** updated: `docs/cells-integration.md` got a `wells-stable-2026-05-10d` row + ⚠️ wake regression banner with `auto_sleep_seconds: null` mitigation + verified substrate facts (create p95, concurrent-fork ceiling, concurrent-restoreState ceiling).

**State at end of cluster:** 532/532 tests green. Stable at `wells-stable-2026-05-10d` (graceful-stop + plist PATH + images shape + pool zombie prune). Wake regression is the gating blocker for further thaw work, autosleep work, and live-verify of W.10/W.11. Pete needs to make the host-reboot call before next fire can make progress on W.27.

**Next:** wait for Pete's W.27 decision OR pick up something wake-independent (W.14 slice 3 if cleared, additional stress profiles, or general doc/cleanup work).

---

## 2026-05-10 08:25 UTC — worker — W.23 + W.25 + stable promotion to `wells-stable-2026-05-10d`

**What happened:** Cells team surfaced three wells follow-ups via Pete's paste at ~02:00-02:18 MT: W.23 pool zombie cleanup, W.24 plist PATH /usr/sbin (already shipped earlier this session, fb3003a), W.25 `GET /v1/wells/images` shape tolerance.

This fire shipped W.23 + W.25, BOARD-cleaned the cells-team list, then cut `wells-stable-2026-05-10d` bundling all three (graceful-stop, plist PATH, images shape, pool zombie) for cells team. Splites-stable worktree moved to the new tag; stable welld restarted, healthz green.

**W.23 (commit `0a3f8e0`):**
- `prunePoolZombies()` runs at welld startup before the filler — walks pool registry, drops members whose lume bundle dir is missing on disk, logs `warn` per prune.
- `well pool drain --all` (and `?all=true` query) drops every member regardless of state, not just `ready`.
- 3 new tests in `lib/poolFiller.test.ts`. Renamed thaw experiment W.23→W.26 to avoid ID collision with cells's W.23.

**W.25 (commit `aee9793`):**
- `handleListImages` per-entry validates against `ImageResource` schema, drops malformed entries with a warn log instead of 500'ing the whole endpoint. Cells's `cmdBake` `.catch(() => null)` no longer collapses on a single drifted meta.
- 1 new regression test in `lib/imageStore.test.ts`.

**Stable promotion:**
- Tag `wells-stable-2026-05-10d` cut from `0a3f8e0`.
- `~/Projects/splites-stable` worktree checked out to the new tag.
- Stable welld + lume serve killed and restarted. Healthz green at 08:22:51 UTC.
- Pushed origin/feature/phase-a + tag.

**Pete in-loop interruptions:**
- Renamed thaw primitive (he flagged "egg multi-hatch" as cells's vocab, not wells's). Settled on `thaw` (single word, evocative).
- Asked status check ("is cells team unblocked, did you update stable") — drove the stable promotion.

**State:** 524/524 tests green. 4 commits this turn (0a3f8e0 W.23, aee9793 W.25, fb3003a plist PATH, 09eb342 prior JOURNAL). W.26 thaw stays In Progress for next fire.

**Next:** thaw phase 2 retry with N=1 (lume crashes under N=2, want to find the threshold), or cells team surfaces a fourth follow-up.

---

## 2026-05-10 08:08 UTC — pete-session+worker — graceful-stop ship + thaw phase 1+2 + cells plist unblock

**What happened:** Bursty session with Pete in the loop. Three deliverables.

1. **Graceful-stop fix shipped** (commit `7d30cb6` + tag `wells-stable-2026-05-10c`). Cells team's NEEDS_PETE.md ping #2 was right — wells's `lume.stop()` was Apple's forceful `VZVirtualMachine.stop()` ("pull the cord"), dropping in-flight VirtIO writes before host fsync. Patch routes through `requestStop()` (ACPI), polls state→.stopped (200ms intervals, 30s timeout), forceful fallback. Smoke verified end-to-end on dev: `well stop`+`start` and `well image save`+fork both preserve `/cell/marker.txt` intact. Splites-stable worktree moved to the new tag. Stable + dev welld both restarted with patched lume binary; W.18 (dev DHCP timeout) cleared as a side effect — was the same lume corruption.

2. **Thaw experiment phase 1+2** (W.23). Phase 1 (sequential): `hibernate.bin` IS portable across bundles iff full bundle mirror (config.json + nvram.bin + disk.img). v1-v3 reject with "invalid argument"; only v4 (full mirror) accepts. Phase 2 (concurrent): 3 simultaneous restoreState calls from one hibernate.bin **crashed dev lume serve**. Hang dump at `/tmp/lume-hang-1778394226122-pid43545.txt`. Real bug data — wells's lume cannot handle 3-way concurrent restore in current shape. Findings: `docs/findings-thaw.md`. Naming locked: "thaw" is the wells verb; cells's "eggs" layer on top.

3. **Cells team plist PATH unblock**. Mid-bake, cells team hit a substrate gap: launchd plist's PATH didn't include /usr/sbin, so `lib/diskReleased.ts` couldn't find `lsof`. Fixed `scripts/welld.plist.template` to include `/usr/sbin:/sbin`.

**Process notes:**
- Pete's name correction: drifted into "egg multi-hatch" (cells's vocab). Wells verb is **thaw**. Renamed before any wrong-named commit landed.
- Initial thaw concurrent script crashed lume → needed a dev welld restart mid-experiment.
- Pete Loop just (re)started this turn at iteration 0; this is fire 1.

**State:** 520/520 green throughout. Commits this turn: `7d30cb6`, `e36b982`, `fb3003a`. BOARD W.23 In Progress with phase 2 follow-ups identified (read hang dump, try N=1, MAC mutation).

**Next:** continue thaw phase 2 — read hang dump, lower concurrency, then look at MAC mutation or a serialized lume queue.

---

## 2026-05-10 (post-MAX_ITER) — steward — first steward fire of the session

**What happened:** Pete Loop hit MAX_ITER=200 in iteration 200, the Stop hook cleared `.claude/.pete-loop.active`, REPL went idle, this steward cron got its first window since being scheduled at ~06:00 UTC. W.22 was right that the loop starved the cron, but the cap-out is itself an unblock event — steward gets a window every ~200 fires under the current architecture.

**State:**
- Worker session shipped 21 W.* items (W.1, W.3-W.13, W.14 s1+s2, W.15-W.17, W.19-W.21) over 28 substantive fires (1-28); cleanup work continued through fire 39; iterations 40-200 were no-op chat-only acknowledgments (most without commits, by the worker's pragmatic choice once steady-state was reached).
- W.18 (dev DHCP timeout) is the load-bearing blocker — gates W.2 / W.7-verify / W.10 / W.11 / W.13 live runs.
- Stable promoted twice: `wells-stable-2026-05-10a` (WS proxy 1011) at 04:22 UTC; `wells-stable-2026-05-10b` (lume supervisor adopted-gap) at 05:40 UTC.
- 520/520 tests green. Build clean.

**Triage decisions (steward step 2):**
- BOARD: no changes needed — worker kept it current through iteration 35 batched-no-op. Done section accurate. In Progress (W.2) accurate. Blocked (W.18) accurate. Todo (W.7 verify, W.14 slice 3 pete-deferred) accurate.
- New BOARD entry would be W.22 follow-through: now that the cron has a "natural every-200-fires window", is that good enough or should we still ship the integrated-steward fix? Pete's call. Logged as `decision-needed`.

**Compaction (steward step 3):** Nothing in JOURNAL is older than 72h yet — entire JOURNAL is from today. Skipped compaction.

**MVP-PLAN reconciliation (steward step 4):** A.2 § "R2 GC tracks local retention" was ticked by W.1's commit. A.2 § "Smoke: round-trip" stays unticked (W.2 live-verify still gated). No drift detected.

**STATUS.md (steward step 5):** Updated — note Pete Loop auto-stop, demote W.22 from "starvation" to "resolved-by-side-effect."

**Touch decision (steward step 6 — SKIPPED per silent-mode override).** Pete's already opted out for the next 8h. Anything Pete-relevant is in NEEDS_PETE.md (rinse audit trail) or BOARD's W.22 with `decision-needed` tag.

---

## 2026-05-10 10:15 UTC — worker — no-op (iteration 39). Awaiting W.18 unblock.

---

## 2026-05-10 10:10 UTC — worker — no-op (iteration 38). Awaiting W.18 unblock.

---

## 2026-05-10 10:05 UTC — worker — no-op (iteration 37). Awaiting W.18 unblock.

---

## 2026-05-10 10:00 UTC — worker — no-op (iteration 36). Awaiting W.18 unblock.

---

## 2026-05-10 09:55 UTC — worker — no-op (iterations 31-35, batched)

Steady state continues. Five fires of incidental cleanup since iteration 30: removed unused `shutdownGuest` import in welld.ts (31), surfaced W.22 steward-cron starvation on BOARD (32), saved a feedback memory about the same (33), refreshed STATUS.md to acknowledge W.22 (34), this entry (35). No substantive worker queue work remains; W.18 unblock is the load-bearing event. Ending fire here.

---

## 2026-05-10 09:40 UTC — worker — no-op (iteration 30)

Steady state. healthz spot-check: stable :7878 lume.owned=true respawns_1h=2 (clean), dev :7879 lume.owned=false respawns_1h=1 (still adopting after earlier restart, supervisor active per W.18 fix). No external changes since iteration 29; not poking dev with a fresh create (would just rediscover the W.18 timeout — memory: "don't loop on live-verify retries").

---

## 2026-05-10 09:35 UTC — worker — no-op (iteration 29)

Queue is genuinely empty: all unblocked W.* items are Done; W.18 is the only Blocked item and gates W.2 / W.7-verify / W.10 / W.11 / W.13 / W.21-verify. W.14 slice 3 is Pete-deferred. Recent fires (24-28) covered the legitimate cleanup work — CLAUDE.md refresh, BOARD banner, STATUS.md refresh, cells-integration.md additions, top-level CLI help, duplicate import in welld.ts, vendor/lume stragglers in scripts + comments, made-up `engine/lume-patches-archive` placeholders. No-op recorded so the next fire has a clear marker that the worker reached steady state without a forced task.

If Pete returns and unblocks W.18 (per `docs/findings-w18-dev-dhcp-timeout.md` recipe 2), the next worker fire should: (1) re-run `scripts/analyze-create-profile.ts` against fresh logs to verify W.7 + W.21 perf wins, (2) run `scripts/smoke-r2-sync.ts` to close W.2 + tick MVP-PLAN A.2 round-trip box, (3) run `scripts/exp-concurrent-fork.ts` to nail B.0.11.d threshold, (4) run `scripts/smoke-wake-stress.ts` + `scripts/smoke-pool-churn.ts` for the cells-team scale-planning data set.

---

## 2026-05-10 09:30 UTC — worker — session arc summary (iterations 1–28)

**Fire spans:** ~5 hours wall-clock from Pete Loop kickoff at iteration 1 (06:00 UTC) through iteration 28 (~09:30 UTC). 28 worker fires, 0 steward fires (steward cron set for :17 every 3h; first fire pending).

**Shipped (feature/phase-a, all on this branch):**

- Stable promotions: `wells-stable-2026-05-10b` at 05:40 UTC (lume supervisor adopted-gap fix to unblock cells team's lume-down incident).
- A.2 R2 polish (W.1): GC tests covering rotate-with-r2, rotate-without-r2, retain-forever opt-out. Closed MVP-PLAN A.2 § R2-GC-tracks-local-retention.
- /healthz pool block (W.9): cells-team-facing predictor for "next create will pool-adopt vs fresh-create."
- Image library on R2 (W.3 + W.4 + W.5): full primitive — design doc, push, pull, auto-pull on `well create --from-image` when env is set. Phase E Colony prerequisite.
- Cells team coordination: rinse-empty-home flag (W.16, cells team accepted, migrating DNA out of /home/well/ → /cell/), `well exec --user=value` parser fix (W.17, equals-syntax now accepted).
- W.18 dev DHCP investigation: full findings doc + 4 unblock recipes; moved to Blocked pending Pete's lume+welld restart.
- W.6 create-warm long tail diagnosed (NOT @MainActor, IS `diskReleased`). p50=14.5s p95=27.1s p99=83.7s across 90 historical creates.
- W.7 + W.21 perf changes: sysrq-s pre-halt (give VZ less to flush) + DHCP poll 2s→500ms. Both blocked on W.18 to verify but should shave ~3-5s off create p50.
- Welld robustness: log audit (W.12) + port-bind exit on EADDRINUSE (W.19) + watchdog backoff after 5 consecutive failures (W.20).
- Stress test scaffolding for cells team scale planning: smoke-wake-stress.ts (W.10), smoke-pool-churn.ts (W.11), exp-concurrent-fork.ts (W.13). All blocked on W.18.
- W.14 lume vendor cleanup slices 1+2: `engine/lume.ts` → `engine/vwell.ts`, `vendor/lume/` → `engine/vwell-src/`, entitlements + LICENSE moved out of vendor/ to engine/, vendor/ removed entirely. Slice 3 (`bin/lume` → `bin/vwell`) deferred to Pete.
- W.15 test isolation findings: confirmed default `bun test` is reliably 520/520; `--concurrent` not safe; documented in checkpoints.test.ts header.
- Doc / cleanup hygiene: CLAUDE.md refresh, cells-integration.md healthz pool + image library additions, BOARD banner update, STATUS.md refresh, top-level CLI help fix, dead vendor/lume.patches references in scripts/activate-signing.sh fixed (was a real broken-path bug; would have re-created the dir on next signing rotation), made-up `engine/lume-patches-archive` placeholders cleaned across 5 docs.

**Read:** worker queue cleared substantially. The remaining items are gated on Pete unblocking dev welld (W.18). Once unblocked, four smokes + the analyze-create-profile.ts re-run can verify W.7 + W.21 perf wins, surface concurrent-fork crash threshold (W.13), and finally tick the A.2 round-trip smoke MVP-PLAN box (W.2).

**Decision:** Pete may want to promote W.7 + W.21 to a `wells-stable-2026-05-10c` once verified — those perf wins are real but not yet stable-side. Recommendation captured in STATUS.md "Pete needs to decide" section.

**Next:** worker continues docs / cleanup work until either Pete returns and unblocks W.18 (cascading five live-runs + verify-perf), or Pete redirects. Steward cron will fire next at the :17 mark of the next 3-hour window — when it does, this entry should be safe to compact since the per-W.* details are captured in BOARD's Done section + commit history.

---

## 2026-05-10 06:00 UTC — worker — W.16 flagged + W.1 closed; W.2 paused mid-orient

**Fire goal:** Started W.2 (R2 round-trip smoke) — checkpoint create → R2 verify → local delete → restore-from-R2 → sha256 match. Got through orientation (welld API surface for create/checkpoint/restore confirmed, wrangler available, dev welld :7879 up) but pivoted before writing the script.

**Pivot trigger:** Pete forwarded a NEEDS_PETE-style draft from the steward channel claiming rinseGuest wipes `/home/well/` and proposing a "narrow rinseGuest to identity-only" fix. Reading `lib/rinseWell.ts:47-58` proved the rinse script is *already* identity-only (machine-id, .well-ready, network state, host SSH keys, .ssh/authorized_keys for both ubuntu and well users). `grep -rn "/home" lib/ daemon/ templates/` returned nothing else wells-side that wipes homes. So the cells-team repro symptom is real (forks come up empty for cells's purposes) but the proposed root cause is wrong; sending the pre-drafted ping would point cells at code that doesn't exist.

Wrote NEEDS_PETE.md with the corrected diagnosis + 4 candidate root causes (well exec user mismatch, cloud-init re-skel on first boot, save-time issue I haven't found, cidata overlay) + an introspection repro Pete or the steward can run on dev. Logged W.16 to BOARD **Blocked** with `cells-team-coordination-needed` + `decision-needed: pete or steward picks up the dev-side repro`.

**Read:** Worker shouldn't send pings on cells's behalf without verifying the technical claim. `RINSE_SCRIPT` is the canonical identity rinse — if forks come up empty, it's not because of rinse.

**Decision:** Worker held W.2 mid-fire to flag the bad-diagnosis loop before it propagated to cells. Per worker rules, that's the right call (cells-team-coordination-needed + decision-needed → Block + pivot). W.2 stays in **In Progress** with a `resume:` note for next fire.

**Next:** Next worker fire resumes W.2 unless Pete redirects. If Pete chooses "yes, run the introspection repro on dev," that's a separate fire (~10 min wall-clock for the repro + report).



## 2026-05-10 04:30 UTC — pete-session — Pete Loop bootstrapped

**What happened:**

- Earlier this session shipped the cells team WS proxy 1011 fix (commits `9c7a34c` → `41d92ab`), promoted to `wells-stable-2026-05-10a`. Cells team unblocked.
- Pete picked the next three priorities in order:
  1. Close out A.2 R2 polish (GC + round-trip smoke).
  2. Image library on R2 (push + pull, design first).
  3. Lume `@MainActor` variance (B.0.9.d.5.b residual — ~20% of smoke cycles bump 15-15.5s).
- Set up Pete Loop infrastructure for splites, modeled on the 3dscan project's setup (`~/Projects/3dscan/.claude/`):
  - `.claude/loops/worker.md` + `.claude/loops/steward.md` — splites-customized prompts (no day/night mode; always on `feature/phase-a`; no sub-branches).
  - `.claude/hooks/pete-loop-stop.sh` — Stop hook that re-injects worker prompt while `.claude/.pete-loop.active` exists. Capped at 200 iterations.
  - `.claude/commands/{start,stop}-pete-loop.md` + `steward.md` — slash commands.
  - `BOARD.md` (new) seeded with the three priorities as `W.1`–`W.7` plus a `W.8` housekeeping item.
  - `JOURNAL.md` (new — this file).
  - `STATUS.md` (new) with current snapshot.
- Setup guide drafted in two locations per Pete's instruction:
  - `~/Desktop/pete-loop-setup-guide.md` (immediate-access copy)
  - `docs/setting-up-pete-loop.md` (version-controlled in repo)

**Read:** Pete Loop is the Kanban + autonomous-fire harness for solo dev work. Splites is now both /mvp-splites (manual one-off via `/loop` or direct invocation) AND Pete Loop (in-session continuous via Stop hook). They're orthogonal — pick whichever fits the moment.

**Decision:** No day/night branch isolation for splites (unlike 3dscan). Splites's branch policy is "everything on `feature/phase-a` until phase rollover" per repo CLAUDE.md, and the cells team coordination model already provides a softer human-in-loop than 3dscan's all-night autonomous mode.

**Next:** Pete kicks off `/start-pete-loop` when ready. Worker picks `W.1` (A.2 R2 GC) first.
