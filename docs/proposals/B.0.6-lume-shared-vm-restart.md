# B.0.6 — Lume's SharedVM should survive lume serve restart

**Status:** proposal · 2026-05-08 · awaits Pete's sign-off

## Problem

Every running well is hostage to the lume serve process. When lume serve restarts — for any reason: our supervisor's false positive, an actual crash, a welld stop call that hangs lume, OS pressure — every VM that lume was managing dies with it. Cells team running 5 wells loses everything on a single hiccup. This is the production-readiness gap.

Concretely: lume keeps an in-memory `[String: VM]` cache (`SharedVM` in `LumeController.swift`) holding `VZVirtualMachine` Swift objects. Those objects can't be migrated across processes. When lume serve dies, the cache is gone; the orphaned `VirtualMachine.xpc` children may keep running, but no process can talk to them.

## What lume already does (the half that works)

`getVMDetailsLightweight()` (LumeController.swift:170-232) handles cross-process detection via *session files*:

- `vmDir.saveSession(VNCSession)` writes `~/.lume/<name>/sessions.json` with the VNC url when a VM starts
- `getDetailsLightweight()` reads it; if the VNC port is in use (`NetworkUtils.isLocalPortInUse`), the VM is marked running even when the SharedVM cache is empty
- Stale entries (port not in use) are cleaned up

So `list()` and `info()` already report "running" correctly across lume restarts. The half that *doesn't* work:

- `pauseVM()`, `resumeVM()`, `stopVM()` need a live `VZVirtualMachine` instance. They check SharedVM only and fail with `VMError.notRunning` if the cache is empty, even when the actual VM process is alive.
- After lume restart, those orphan `VirtualMachine.xpc` children can't be controlled by anyone. They sit there holding RAM until the user manually `kill`s them.

## Proposed fix — kill orphans cleanly on lume startup

Treat lume restarts as full state loss for *running* VMs. Disk state survives (bundle dir is on-disk). Process state doesn't, because we can't reattach to a `VZVirtualMachine` from a different process. So the right semantic is: **on lume serve startup, sweep any session-file-marked "running" VMs and kill their orphan XPC children, leaving disk state intact for a fresh run.**

The existing supervisor + welld lifecycle then works correctly: after a lume crash, our supervisor respawns lume, lume cleans up orphans, welld notices wells went stopped (by polling lume.list()), and `ensureRunning` brings them back via a fresh boot.

Why not "reattach to running VMs"? Because Apple's `VZVirtualMachine` has no API for that. The class is owned by the spawning process; orphan XPC children are unreachable.

## Changes — minimal patches in engine/vwell-src/ (formerly patched separately under vendor/lume.patches/swift/)

### 1. Enrich `VNCSession` with the XPC child PID

`engine/vwell-src/src/FileSystem/VMDirectory.swift:143-151`

```swift
struct VNCSession: Codable {
    let url: String
    let sharedDirectories: [SharedDirectory]?
    let xpcPid: Int32?  // NEW: PID of the VirtualMachine.xpc child holding this VM
    
    init(url: String, sharedDirectories: [SharedDirectory]? = nil, xpcPid: Int32? = nil) {
        self.url = url
        self.sharedDirectories = sharedDirectories
        self.xpcPid = xpcPid
    }
}
```

### 2. Capture the XPC child PID when VM starts

`engine/vwell-src/src/VM/VM.swift:792-807` (`saveSessionData`)

The XPC child is spawned by `VZVirtualMachine.start()`. Apple doesn't expose its PID directly, but we can find it: enumerate child processes of `getpid()` and pick the one whose executable is `Virtualization.VirtualMachine`. Use `proc_listchildpids()` from `libproc.h` (or `Process.childProcesses` on newer Swift). Store in the session.

### 3. On lume serve startup, sweep orphans

New `LumeController.cleanupOrphanedVMs()` runs once at startup:

```swift
@MainActor
public func cleanupOrphanedVMs() async {
    for vmDir in home.allVMDirectories() {
        guard let session = try? vmDir.loadSession() else { continue }
        // Three states for the orphan PID:
        if let pid = session.xpcPid {
            if processIsAlive(pid) && !processIsOurChild(pid) {
                // Orphan from a previous lume serve. Kill it.
                kill(pid, SIGKILL)
                Logger.info("Killed orphan XPC child", metadata: ["name": vmDir.name, "pid": "\(pid)"])
            }
        }
        // Whether or not we killed something, the session is stale. Clear it.
        vmDir.clearSession()
    }
}
```

Called from `Server.run()` (or whatever bootstraps lume serve) before any HTTP route handlers come online.

### 4. Welld startup also re-checks

Welld already has `lib/lumeRunGc.ts` for sweeping dangling `lume run` subprocesses. Add a sister sweep that calls a new `lume serve` admin endpoint (`POST /lume/admin/sweep-orphans`) at welld startup — defense in depth.

## What the fix gets us

- Lume crash + supervisor respawn → all wells correctly become `stopped` after lume comes back, no zombie processes hogging RAM
- `well start <name>` works against any well after lume restart (boots fresh from disk; cell-side state persists)
- Cells team can run 5+ wells without single-process risk
- The cooperation API + auto-pause flow becomes resilient to lume hiccups

## What it doesn't fix

- VMs that were paused (in RAM, not yet hibernated) lose their RAM state. Can't be helped — the `VZVirtualMachine.saveState()` API would be needed for that, which is the hibernation patch (A.1.3.e.2).
- In-flight WS exec sessions die. Caller has to retry. Acceptable.

## Estimated cost

- Item 1 (session struct): ~10 lines, trivial. Swift codable migration handles old session files (xpcPid optional).
- Item 2 (PID capture): ~30 lines, including the `proc_listchildpids` glue. Some platform-specific code.
- Item 3 (sweep on startup): ~50 lines. Mostly path enumeration + process inspection.
- Item 4 (welld sweep call): ~10 lines TypeScript. A new admin endpoint in lume's HTTP server.

Total: ~100 lines of Swift + tests, plus rebuild + re-sign + re-notarize lume.app. One fire to write the patch, one to build + smoke verify, one to merge after Pete signs the new lume binary.

## Risks

- **Session file write must not race the start.** Today, session is saved *after* VNC service starts. The XPC child PID is available right after `VZVirtualMachine.start()` returns. We need to write the session early enough that a crash mid-start still leaves a recoverable state. May need to write the session twice (once with PID, once with VNC URL added).

- **`proc_listchildpids` returns immediately after fork, but the executable name may not be set yet.** If we capture the PID too early, we might pick up a transient helper process. Need a small retry loop polling for the right executable name.

- **Cleaning orphans changes lume's behavior for users running lume directly.** If a user has `lume serve` and a separate `lume run pete` in two terminals, restarting `lume serve` would kill `pete`. Mitigation: only sweep if PID's parent is dead AND session file's xpcPid was set by a previous lume serve. Adds a "lume serve PID" field to the session for that distinction.

- **Re-notarize cycle.** Each new lume.app signed binary needs Apple notarization. Pete's account works; cycle is ~5min including upload + staple.

## Open questions for Pete

1. Sign off on the orphan-kill semantic, or push back? Alternative is "leave orphans alone, but mark them dead in the session file" — at the cost of zombies hogging RAM until manual cleanup.
2. Want a design review at proposal stage, or should I just go write the patch and you review the diff?
