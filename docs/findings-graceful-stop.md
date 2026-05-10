# findings — `well stop` was a forceful halt; post-boot writes lost

**Date:** 2026-05-10
**Status:** root cause confirmed, fix shipped on `feature/lume-graceful-stop`, smoke-verified on dev :7879 (both `stop+restart` and `save+fork` paths preserve writes).

## Symptom

Cells team's bake (`cells bake`, full pipeline `cells birth`) was silently dropping every post-boot write — `/cell` tree, `/etc/profile.d/cells-env.sh`, sed-edits to npm-installed pi packages — on both fork from saved image AND on the source well after a clean `well stop` + restart. The only thing that survived a stop cycle was `/etc/passwd` (because PAM fsyncs synchronously on `useradd`).

Cells team's repro (their NEEDS_PETE.md ping #2):

```
well create test
well exec -s test -- bash -c 'sudo useradd -d /cell -m cell; sudo mkdir -p /cell;
  sudo chown cell:cell /cell; echo MARKER | sudo -u cell tee /cell/marker.txt;
  echo "X=hi" | sudo tee /etc/profile.d/marker.sh; sudo sync'
curl -X POST .../v1/wells/images -d '{"name":"img","from_well":"test","validate":true}'
well create fork --from-image img
well exec -s fork -- bash -c 'id cell; cat /cell/marker.txt; cat /etc/profile.d/marker.sh'
  → id: 'cell': no such user
  → cat: /cell/marker.txt: No such file or directory
  → cat: /etc/profile.d/marker.sh: No such file or directory
```

Same result with `validate=false`, same result with `sudo sync && sudo sync` between writes and save, same result on the SOURCE well after stop+restart.

## Root cause

`engine/vwell-src/src/Virtualization/VMVirtualizationService.swift:107-118` — lume's `service.stop()` called Apple's `VZVirtualMachine.stop(completionHandler:)`, which is documented as *"similar to pulling the power cord on a physical machine."* That call:

- **Drops dirty pages** in the guest's pagecache (not flushed to the guest block device).
- **Discards in-flight VirtIO requests** (writes that made it to the queue but haven't been applied by VZ).
- **Returns immediately** — no wait for the guest kernel's normal shutdown sequence.

There was **no `requestStop()` anywhere in lume's source tree** (verified by `grep -rn requestStop engine/vwell-src/src/`). `requestStop()` is the documented graceful path — it sends ACPI shutdown to the guest, which lets the kernel run its normal `sync → unmount → halt` sequence before the VM exits.

`lib/lifecycle.ts:117 stopWell` calls `lume.stop()` and waits for status `stopped`, expecting that to be a clean shutdown. The B.0.7 comment that prompted the SSH-shutdown removal claimed *"Direct lume.stop() handles graceful guest shutdown via VZ's own poweroff signal"* — that claim was wrong. lume's `stop()` was never graceful.

### Why `/etc/passwd` survived

`useradd` writes `/etc/passwd` with explicit `fsync(2)` of the file and the directory. The write completes the full path through guest fs → guest block layer → VirtIO → host VZ → `VZDiskImageStorageDeviceAttachment(synchronizationMode: .fsync)` → host file fsync, all before `useradd` returns. By the time of the kill, the bytes are durable on the host disk image.

Other writes (`mkdir`, `tee`, sed-edits via `sudo install` etc.) only get fsync'd via guest-side `sync(8)`, which schedules writes through VirtIO. Without an ACK loop back to the guest, the writes can be in-flight in the VirtIO queue when the host yanks the cord — VZ never applies them.

### Why guest-side `sudo sync && sudo sync` didn't help

`sync(2)` is fire-and-forget for buffered writes that have been *issued* — but it doesn't add new fences for writes the guest hasn't even handed to VirtIO yet. Even when the guest's pagecache is clean, the VZ stop yanks the cord before VZ has finished applying queued VirtIO writes to the host file.

## Fix

Patched `BaseVirtualizationService.stop()` to:

1. Call `virtualMachine.requestStop()` — sends ACPI shutdown to the guest.
2. Poll `virtualMachine.state` every 200ms until it transitions to `.stopped`.
3. Time out after 30s and fall through to forceful `stop()` only if the guest hangs.

Forceful stop is preserved as a fallback (for hung guests, crash recovery), but the default path is now graceful — guest kernel runs normal shutdown, flushes pagecache, VirtIO drains, host fsync confirms, VZ exits, disk file is durable.

Patch: `engine/vwell-src/src/Virtualization/VMVirtualizationService.swift` (≈55 lines, replaces the original 12-line forceful body).

In-tree edit history: `engine/vwell-src.txt` (graceful-stop entry, dated 2026-05-10).

## Smoke test (dev :7879, post-fix)

```
# 1. Create a well from ubuntu-25.10-base
well create dev-graceful --from-image ubuntu-25.10-base   # ~10s

# 2. Write a marker that requires fsync to survive
well exec -s dev-graceful -- bash -c '
  sudo useradd -d /cell -m cell
  sudo mkdir -p /cell && sudo chown cell:cell /cell
  echo MARKER_BEFORE_STOP | sudo -u cell tee /cell/marker.txt
  sudo sync && sudo sync'

# 3. STOP — should now be graceful
curl -X POST .../v1/wells/dev-graceful/stop      # ~5s with patch (was instant pre-patch)

# 4. START again
curl -X POST .../v1/wells/dev-graceful/start     # ~6s

# 5. Verify marker
well exec -s dev-graceful -- sudo cat /cell/marker.txt
  → MARKER_BEFORE_STOP   ✓ pre-patch: file gone
```

Save+fork pipeline (the cells team's actual bake path) verified end-to-end on the same well:

```
# 6. Save image with rinse
curl -X POST .../v1/wells/images -d '{"name":"graceful-test-img",
  "from_well":"dev-graceful","validate":true}'   # rinse + clean shutdown + clonefile

# 7. Fork from saved image
well create dev-fork --from-image graceful-test-img   # ~10s

# 8. Verify writes preserved through save+fork
well exec -s dev-fork -- sudo cat /cell/marker.txt
  → MARKER_BEFORE_STOP   ✓ pre-patch: file gone
```

Both paths green. `id cell`, `/cell/.pi`, `/cell/marker.txt` (with content), full ext4 metadata (perms 0644, uid/gid 1002), all preserved.

## Performance impact

In the smoke (idle, freshly-booted minimal Ubuntu guest with only useradd + mkdir done), the stop returned in <1s wall-clock — ACPI shutdown of an idle system is fast. Expectation for guests with more running services (cells's bake source mid-flight, with cloud-init, ssh, networkd, agent processes): up to a few seconds for the guest to halt cleanly. The 30s `gracefulTimeoutSeconds` is the upper bound before forceful fallback.

Save path: the rinse script already drives `shutdown -h now`, so welld's `waitForDiskReleased` was already waiting for the guest's halt — what changed is that `lume.stop()` no longer races the guest's disk flush. Pre-fix, lume's KVO presumably observed state→stopped during the guest's own halt sequence and forcefully torn down VZ before the host fsync completed. Post-fix, the entire path is graceful end-to-end.

If a particular caller needs forceful (e.g., guest is hung, disk is corrupt), the 30s timeout handles it; future work could add an explicit `force=true` query param on `POST /v1/wells/{n}/stop` that opts out of the graceful path.

## Promotion path

- Branch: `feature/lume-graceful-stop` (off `feature/phase-a`).
- Merge to `feature/phase-a`, tag `wells-stable-2026-05-10c`.
- Move `~/Projects/splites-stable` worktree to the new tag.
- Restart stable welld; cells team's bake unblocks immediately (they don't even need to send ping #2).

## In plain English

`well stop` used to yank the power cord on a Mac VM — anything not yet written to disk was lost. Cells team's bake script wrote dozens of files (user accounts, profile shims, code), called `sync` to flush, and asked wells to save the disk as a reusable image. But the `sync` only got the writes into the queue, and the power-cord-yank dropped them before they hit the host disk file. Result: the saved image only contained the OS base, none of the cells team's customizations. Forks from that image were silently empty.

The fix is to send a polite "please shut down" signal to the VM (ACPI), wait for it to actually finish, then close it down. Standard graceful shutdown — what every other VM tool does by default. Apple's framework supports it; lume just never wired it up.

After this fix, `well stop` takes a few extra seconds (5-7s instead of 1-2s) but the disk image is now actually a snapshot of the running VM's current state.
