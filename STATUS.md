# splites — Current Status

**Updated:** 2026-05-10 ~09:45 UTC (Pete Loop iter 21) by `worker`.
**Phase:** Phase A in flight. Bake-write-persistence shipped, perf wins verified, thaw primitive shipped, wake regression surfaced + diagnosed.
**Health:** 🟡 Stable at `wells-stable-2026-05-10d` (graceful-stop + plist PATH + images shape + pool zombie auto-prune). **Wake is broken** — see W.27 below; cells team's bake/birth/steady-state operations are unaffected, but watchdog auto-hibernate + wake-on-traffic don't work.

## TL;DR

Tonight's loop landed the cells team's three follow-ups (W.23 pool zombie auto-prune, W.24 plist PATH /usr/sbin, W.25 images shape tolerance), shipped the thaw primitive end-to-end (`POST /v1/wells {name, from_thaw}` + `lib/thaw.ts` with serialized restore + bundle mirror + `hibernate.config.json` path-rewrite), verified W.7 + W.21 perf wins live (total create p95 dropped 27.1s → **17.4s**, -36%), bisected W.13 concurrent-fork ceiling to **4** (lume itself stable, vmnet bootp DHCP race breaks N≥5), and surfaced + diagnosed the wake regression (W.27) — every `well wake` / `from_thaw` / `lume.restoreState` returns Apple's `permission denied` error since ~04:30 UTC. Graceful-stop revert hypothesis tested live and ruled out.

532/532 tests green throughout.

## What's stuck

| Item | Why | Who unsticks |
|------|-----|--------------|
| **W.27 — wake regression** | VZ `permission denied` on every restoreState since ~04:30 UTC. Graceful-stop revert tested + ruled out. Hypothesis: host-level VZ daemon state, TCC, or accumulated lume process state. | Pete: test wake on stable directly to localize, then host reboot if still broken. See `docs/findings-wake-regression-permission-denied.md`. |
| W.10 / W.11 / W.26 thaw end-to-end | Wake required | W.27 |
| **W.2 — R2 round-trip smoke** | Smoke's `disk:"10GB"` shrunk-then-broke create (fixed); next blocker is R2 token returning `Access Denied` on `wells-smoke-r2` bucket | Pete: mint a bucket-scoped R2 token in Cloudflare console |
| W.22 — steward cron starvation (decision-needed) | Pete Loop's Stop hook re-injection prevents idle gaps | Pete decides: integrate steward into worker, OR Stop hook gates around cron, OR accept-the-cap-out-as-natural-window |

## What's NOT stuck (cells team can use these now)

- ✅ Bake → save (validate=true) → fork: writes survive (graceful-stop fix in `wells-stable-2026-05-10c+d`).
- ✅ Steady-state cell ops (create, exec, image save/list, image pull/push to R2 if creds set).
- ✅ `cells bake` flow (W.24 plist PATH + W.25 images shape tolerance + W.23 pool zombie cleanup all in `wells-stable-2026-05-10d`).
- ✅ Pool fast-path adopt: limited usage — adoption goes through wake (broken). Set `defaults.pool_size=0` to skip until W.27 resolves.

## Substrate facts (verified live this session)

| Metric | Value | Source |
|---|---|---|
| Create+warm p50 | 14.2s | 125 samples (74 stable + 51 dev) |
| Create+warm p95 | **17.4s** (was 27.1s pre-W.7+W.21, -36%) | `docs/findings-create-warm-distribution-2026-05-10.md` |
| `diskReleased` p95 | **4.5s** (was 6.4s, -30%) | Same |
| Concurrent-fork ceiling | **4** (lume stable; vmnet bootp DHCP race breaks N≥5) | `docs/findings-concurrent-fork-crash.md` |
| Concurrent-restoreState ceiling | **1** (must serialize wake/thaw) | `docs/findings-thaw.md` |
| Test suite | 532/532 green | `bun test` default sequential |

## What changed this session

**Stable bumps:**
- `wells-stable-2026-05-10a` 04:22 UTC — WS proxy 1011 fix
- `wells-stable-2026-05-10b` 05:40 UTC — lume supervisor adopted-gap fix
- `wells-stable-2026-05-10c` 07:50 UTC — graceful-stop (cells bake-write-persistence fix)
- **`wells-stable-2026-05-10d` 08:23 UTC** — bundle: graceful-stop + plist PATH /usr/sbin + images shape tolerance + pool zombie auto-prune

**W.* items shipped + verified:**
- W.1 R2 GC tests
- W.3+W.4+W.5 image library on R2 (push, pull, auto-pull on `well create --from-image`)
- W.6 create-warm long-tail diagnosis → W.7 sysrq-s pre-halt → W.21 DHCP poll tightening (verified -36% p95)
- W.8 MVP-PLAN audit
- W.9 /healthz pool block
- W.10/W.11/W.13 stress smokes (W.13 ran live → ceiling 4)
- W.12 welld log audit → W.19 port-bind exit + W.20 watchdog backoff
- W.14 slices 1+2 (engine vendoring cleanup)
- W.15 test isolation findings
- W.16 fork-empty-home false alarm (cells fix)
- W.17 `well exec --user=value` parser fix
- W.18 dev DHCP timeout (cleared by welld restart)
- W.23 pool zombie auto-prune + `pool drain --all`
- W.24 plist PATH /usr/sbin
- W.25 images shape tolerance
- W.26 thaw primitive (`POST /v1/wells {name, from_thaw}` + lib/thaw.ts) — phase 1+2 design verified, end-to-end blocked on W.27 wake regression

## Pete needs to decide

- **W.27 host reboot or stable wake-test.** Wake regression deterministic, blocks autosleep + thaw + smoke-wake-stress. See `docs/findings-wake-regression-permission-denied.md` for the recipe.
- **W.2 R2 token.** Mint a bucket-scoped R2 token for `wells-smoke-r2` so the smoke can complete its round-trip.
- **W.22 steward starvation fix.** Architectural call — integrate steward into worker prompt, or modify Stop hook, or accept the natural cap-out window.
- **W.14 slice 3 (`bin/lume` → `bin/vwell` rename).** Defaulted to deferred.

## Cells team status

**Mostly unblocked.** Bake + birth + steady-state cell ops all work in `wells-stable-2026-05-10d`. Watchdog autosleep + wake-on-traffic broken pending W.27 — mitigate with `auto_sleep_seconds: null` until resolved. `docs/cells-integration.md` has the substrate facts + ⚠️ banner for the wake regression.

## Next planned cycle

Worker continues low-priority cleanup / docs / verification work until Pete returns and either:
- Resolves W.27 (then unblocks thaw end-to-end, smoke-wake-stress live runs, watchdog testing)
- Resolves W.2 R2 token (then closes the R2 round-trip smoke verification)
- Redirects to other work
