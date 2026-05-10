# Two lume serves on different ports SIGKILL each other's VMs

**Date:** 2026-05-09 22:25 UTC
**Symptom:** Stable's lume crashes every 2-4 minutes when dev's lume serve is also running. Both `exitCode:null` (hung, not panicked). Crash times match exactly across both lumes (within 200ms).
**Severity:** Production-impacting. Cells team blocked on stable bakes when dev welld is running concurrently.

## Root cause

`engine/vwell-src/src/LumeController.swift:189` orphan-sweep on lume serve startup runs:

```swift
let vmPids = XPCChildLocator.findAllVMProcesses()
for pid in vmPids {
    if kill(pid, SIGKILL) == 0 { ... }
}
```

`XPCChildLocator.findAllVMProcesses()` (`engine/vwell-src/src/Virtualization/XPCChildLocator.swift:33`) walks `proc_listallpids` and filters by executable path matching `"Virtualization.VirtualMachine"`. **It has no notion of which lume instance owns which VM.** Every running `VirtualMachine.xpc` on the host is treated as an orphan and SIGKILLed.

The lume comment acknowledges the tradeoff (`LumeController.swift:184`):
> "Tradeoff: this is aggressive. If a separate instance of lume (not under welld supervision) is running concurrently, we kill its VMs too."

But our wells stable + dev split runs two welld-supervised lume serves on different ports. Each respawn fires the global sweep, killing the other's VMs, which crashes the other's lume, which respawns and sweeps back. Death spiral.

## Evidence

Stable welld log entries 2026-05-09 22:13:23.051 and 22:18:58 both have matching dev welld respawn entries within 100-300ms. Both lumes crash `exitCode:null` (hung), within the same 1-second window, repeatedly.

## Workaround (tonight)

**Don't run dev welld concurrently with cells team's stable testing.** Wells team killed dev welld + dev lume at 22:25 UTC. Stable should stabilize.

Trade-off accepted: dev work pauses while cells team is testing on stable. The "stable + dev side-by-side" architecture from `docs/cells-integration.md` § "Why this exists" is conditional on lume's orphan-sweep being more selective.

## Permanent fix (lume patch needed)

`XPCChildLocator.findAllVMProcesses()` needs to filter to VMs spawned by *this* lume instance only. Options:

1. **Process group tagging.** Each lume serve sets its PGID via `setpgid(0, 0)`; spawn VZ XPCs into the same group. Sweep filters by PGID match.
2. **Sidecar PID file.** Each VM directory writes `lume-pid` (the spawning lume's PID) alongside the session file. Sweep skips VMs whose `lume-pid` corresponds to a *different alive lume process*.
3. **Lock file per VM dir.** Spawning lume holds a `flock` on the VM dir. Sweep only kills VMs whose lock isn't held by a live process.

Option 2 is simplest. Lives on a `feature/lume-orphan-sweep-scoped` sub-branch; merges to wells via `engine/lume-patches-archive/`.

## Until the lume patch lands

- Wells dev work stops when cells team is live on stable.
- Or: dev welld switches to `lume run` subprocess mode (no orphan sweep), losing pause/resume for dev wells. Acceptable for benchmark/perf work that doesn't need hibernation.
- Or: scope dev to a chroot or explicit launchd label that survives orphan-sweep filtering. Speculative.
