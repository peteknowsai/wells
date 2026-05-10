# NEEDS_PETE — open decisions

**Mode:** silent (Pete async + opted out of touches). Steward consolidates outstanding Pete decisions here for own-schedule read. Top section is current-open; rinse audit trail preserved below for archaeology.

---

## Currently open (steward 2026-05-10 10:30 UTC)

Three Pete decisions outstanding. None blocks cells team's main flows (bake/birth/steady-state all work in `wells-stable-2026-05-10d`).

### 1. W.27 — wake regression (host-level, recommended action: reboot)

Every `well wake` / `from_thaw` / `lume.restoreState` returns Apple VZ "permission denied" since ~04:30 UTC. Graceful-stop revert tested live + ruled out (worker bisected at 09:11 UTC: revert + rebuild + dev welld+lume restart → wake still fails). Cause is below us in the stack: Apple's VZ daemon, TCC state, or accumulated lume process state across this session's many `killAndRestart` cycles.

- Live impact: smoke-wake-stress run shows 0/30 cycles passed (`docs/findings-wake-stress-2026-05-10.md`).
- Cells team mitigation: `auto_sleep_seconds: null` so cells stay alive (already in `docs/cells-integration.md` ⚠️ banner).
- Recommended action: **(a)** test wake on stable directly to localize (operator-only, ~2 min) — if stable wake also fails, it's host-level. **(b)** Reboot the host. Cheapest "is it host-level" check; brief downtime for cells team.
- Reverting graceful-stop: NOT a fix (verified) and would re-break cells's bake. Keep graceful-stop in place.
- Full diagnostic: `docs/findings-wake-regression-permission-denied.md`.

### 2. W.2 — R2 round-trip smoke (R2 token)

`scripts/smoke-r2-sync.ts` is shipped + bisected past the prior `disk:"10GB"` shrink bug. Last-mile blocker: bucket-scoped R2 token returning `Access Denied` on `wells-smoke-r2`.

- Action: mint a bucket-scoped R2 token in the Cloudflare console (account `5a6fef07a998d84ec047ef43d0543342`) for bucket `wells-smoke-r2` (read+write), drop credentials into the smoke env, and run.
- Closes MVP-PLAN A.2 § "Smoke: round-trip" once green.

### 3. W.22 — steward-cron starvation (durable fix call)

Pete Loop's Stop hook re-injects the worker prompt every turn, so the REPL is never idle and CronCreate jobs only fire when idle. The 06:00 UTC steward cron didn't fire once during the 200-iter worker run — but **MAX_ITER=200 auto-stop opened the idle window**, and this steward fire is concrete proof the cap-out architecture works.

Three options:
- **(a)** Integrate steward INTO the worker (every Nth fire becomes a steward fire). ~30-60 min of design + plumbing.
- **(b)** Modify the Stop hook to skip re-inject if the next steward fire is within ~5 min. ~30 min.
- **(c)** Accept the cap-out window as the steward cadence (every ~200 fires ≈ ~17 wall-clock-hours, roughly daily). Zero engineering. Predictable.

**Recommendation: (c).** Today proved it works, and the 200-fire window is roughly daily for typical loop pacing. If you want tighter cadence, (a) is the cleaner long-term shape (worker already has the context + permissions to do steward work).

### 4. W.14 slice 3 — `bin/lume` → `bin/vwell` rename

Pete-deferred. Slice 1 + slice 2 of W.14 shipped. Only `bin/lume` rename remains. Low value (forces a stable wrapper update + probably a stable promotion to keep cells team uninterrupted). Awaiting Pete's call to pick up or close.

---

## RESOLVED 2026-05-10 06:10 UTC — rinse-empty-home claim

**Status:** Cells team responded after worker flagged the code/claim mismatch. Their fix (not wells's): they're moving cells DNA out of `/home/well/` to `/cell/` (~2h grep-and-replace on their side). Wells's rinse stays as-is — confirmed identity-only per the code below. Their only ask was a doc note explaining exactly what `validate=true` rinses; that's now in `docs/cells-integration.md`. This file kept as the audit trail of the misdiagnosis investigation.

---

### Original worker analysis (2026-05-10 06:00 UTC)

Worker found a discrepancy between the cells-team ping draft and the actual rinse code. **Don't send the ping as drafted.** The recommendation in the ping ("narrow rinseGuest to identity-only") is wrong — `RINSE_SCRIPT` is already identity-only.

#### What the ping claims

> `POST /v1/wells/images {validate:true}` wipes /home/well/ on the source before clonefile — not just identity (machine-id, .well-ready, network, ssh keys).

#### What the code actually does

`lib/rinseWell.ts:47-58` — the entire rinse script:

```bash
set -e
sudo rm -rf /var/lib/systemd/network/*
sudo rm -f /etc/machine-id /etc/.well-ready
sudo touch /etc/machine-id
sudo rm -f /etc/ssh/ssh_host_*
sudo rm -f /home/ubuntu/.ssh/authorized_keys
sudo rm -f /home/well/.ssh/authorized_keys 2>/dev/null || true
echo rinsed
sudo sync
sudo shutdown -h now
```

Identity-only. Doesn't touch `/home/ubuntu/` or `/home/well/` content beyond `.ssh/authorized_keys`. `grep -rn "/home" lib/ daemon/ templates/` returns only this file + `well-firstboot.sh:76-77` (which only touches `/home/ubuntu/.ssh` on first boot of a fresh fork).

So if the cells repro produces an empty `/home/well/agent/` on fork, the cause isn't rinse. Possibilities to investigate before pinging cells:

1. **Cells writes to `/home/ubuntu/`, not `/home/well/`.** Default well user is `ubuntu` per `well-firstboot.sh`. If `cells birth` puts the DNA at `~/agent/` and that resolves to `/home/ubuntu/agent/`, both the source well and the fork should have it. If only the source has it but fork doesn't, something on the create-from-image path is wiping `/home/ubuntu/agent/`.
2. **Cloud-init resets `/home/` on first boot.** We've been disabling cloud-init for hibernate (per the parked B.0.9.d.2 plan). If cloud-init *isn't* properly disabled on `ubuntu-25.10-base`, the `users:` directive could rebuild `/home/<user>` from skel on first fork boot.
3. **`well exec` user mismatch between create and fork.** Repro creates marker as one user, fork's `well exec` runs as another, can't see the file but it's still on disk.
4. **clonefile is consistent but cidata erases on fork.** `cidata.iso` regen on first boot of the fork could mount-overlay something onto `/home`. Less likely.

#### What worker did

- Read `lib/rinseWell.ts` end-to-end and grepped repo for any `/home/` references — confirmed rinse is already identity-only.
- Logged this NEEDS_PETE entry instead of sending the ping.
- Continuing worker fire on W.2 (R2 round-trip smoke).
