import Darwin
import Foundation

// Locator for the `VirtualMachine.xpc` child process that Apple's
// Virtualization.framework spawns when we call `VZVirtualMachine.start()`.
// Used by the orphan-sweep on lume serve startup (B.0.6) — the child's
// PID gets persisted in VNCSession at start time so the next lume
// serve can identify it as an orphan if its parent (the original lume
// serve) is dead.
//
// Apple doesn't expose the child PID via the VZ API, so we walk our
// own child-process table via libproc and pick the most-recently-
// spawned one matching the VirtualMachine executable.

enum XPCChildLocator {
    /// Marker substring that uniquely identifies the VZ XPC service
    /// binary. The full path is something like:
    ///   /System/Library/Frameworks/Virtualization.framework/Versions/A/
    ///   XPCServices/com.apple.Virtualization.VirtualMachine.xpc/
    ///   Contents/MacOS/com.apple.Virtualization.VirtualMachine
    private static let xpcMarker = "Virtualization.VirtualMachine"

    /// Returns the highest-numbered (most recently spawned) PID among
    /// the current process's children whose executable path matches
    /// the VZ XPC service. Returns nil if no such child exists.
    ///
    /// Polls briefly because Apple's `start()` may return before the
    /// child is fully forked + execed; we accept a small wait rather
    /// than trying to race the kernel.
    static func findRecentVMChild(timeoutMs: Int = 2_000) -> Int32? {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000.0)
        repeat {
            if let pid = scanOnce() { return pid }
            Thread.sleep(forTimeInterval: 0.05)
        } while Date() < deadline
        return nil
    }

    /// One pass over our child-process table. Public for testability.
    static func scanOnce() -> Int32? {
        let parent = getpid()
        // proc_listchildpids needs a buffer sized in bytes. Ask once for
        // the buffer size, then again with the right buffer.
        let needed = proc_listchildpids(parent, nil, 0)
        if needed <= 0 { return nil }
        let count = Int(needed) / MemoryLayout<pid_t>.size
        var pids = [pid_t](repeating: 0, count: count)
        let written = pids.withUnsafeMutableBufferPointer { buf in
            proc_listchildpids(parent, buf.baseAddress, Int32(buf.count * MemoryLayout<pid_t>.size))
        }
        if written <= 0 { return nil }
        let actualCount = min(Int(written) / MemoryLayout<pid_t>.size, pids.count)
        let validPids = Array(pids.prefix(actualCount))

        var best: pid_t = 0
        for pid in validPids where pid > 0 {
            if executableContains(pid: pid, marker: xpcMarker) {
                if pid > best { best = pid }
            }
        }
        return best > 0 ? best : nil
    }

    /// True if the executable path of the given PID contains `marker`.
    /// Returns false on error (process gone, permission denied, etc).
    ///
    /// Buffer is sized to PROC_PIDPATHINFO_MAXSIZE (4 * MAXPATHLEN = 4096
    /// on macOS). The C macro isn't bridged to Swift, so the constant
    /// is inlined; if Apple ever changes it, update here.
    static func executableContains(pid: pid_t, marker: String) -> Bool {
        let bufSize = 4 * 1024
        var pathBuf = [CChar](repeating: 0, count: bufSize)
        let n = proc_pidpath(pid, &pathBuf, UInt32(bufSize))
        guard n > 0 else { return false }
        let path = String(cString: pathBuf)
        return path.contains(marker)
    }

    /// True if the given PID currently exists. Cheap check via kill(0).
    /// Used by orphan-sweep to skip dead PIDs before SIGKILLing them.
    static func isAlive(pid: pid_t) -> Bool {
        // kill(pid, 0) doesn't deliver a signal — it just probes. Returns
        // 0 if the process exists and we have permission, -1 with
        // ESRCH if no such process. Other errors (EPERM) we treat as
        // "alive but unreachable" → return true (better to leave a
        // stranger process alone than to assume it's dead and skip).
        let r = kill(pid, 0)
        if r == 0 { return true }
        return errno != ESRCH
    }
}
