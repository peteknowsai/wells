import Darwin
import Foundation

// Locator for the `VirtualMachine.xpc` process that Apple's
// Virtualization.framework owns for our running VM. Used by the
// orphan-sweep on lume serve startup (B.0.6).
//
// We can't walk by parent: Apple launches XPC services via launchd, so
// the VZ child's PPID is 1, not lume's PID. Instead we look up the
// process by the VNC TCP port — each VM has a unique port that the
// XPC child binds, persisted in the session file. Shells out to
// `lsof -nP -iTCP:PORT -sTCP:LISTEN -t` (always present on macOS) and
// verifies the executable matches the VZ marker before treating the
// PID as ours.

enum XPCChildLocator {
    /// Marker substring that uniquely identifies the VZ XPC service
    /// binary. The full path is something like:
    ///   /System/Library/Frameworks/Virtualization.framework/Versions/A/
    ///   XPCServices/com.apple.Virtualization.VirtualMachine.xpc/
    ///   Contents/MacOS/com.apple.Virtualization.VirtualMachine
    static let xpcMarker = "Virtualization.VirtualMachine"

    /// Enumerate all PIDs on the system whose executable matches the
    /// VZ XPC service. Used by the orphan-sweep on lume serve startup —
    /// at startup we haven't spawned any VMs yet, so any existing
    /// VirtualMachine.xpc process is by definition an orphan from a
    /// previous lume serve.
    ///
    /// Apple launches XPC services via launchd (PPID=1), so they don't
    /// appear in our child-process tree. Walking all PIDs and filtering
    /// by executable is the only reliable way.
    static func findAllVMProcesses() -> [Int32] {
        // proc_listallpids: ask once for the buffer size, then again
        // with the right buffer.
        let bufSize = proc_listallpids(nil, 0)
        if bufSize <= 0 { return [] }
        let count = Int(bufSize) / MemoryLayout<pid_t>.size
        // Pad slightly — process count can grow between the two calls.
        let padded = count + 64
        var pids = [pid_t](repeating: 0, count: padded)
        let written = pids.withUnsafeMutableBufferPointer { buf in
            proc_listallpids(buf.baseAddress, Int32(buf.count * MemoryLayout<pid_t>.size))
        }
        if written <= 0 { return [] }
        let actualCount = min(Int(written) / MemoryLayout<pid_t>.size, pids.count)
        return pids.prefix(actualCount).filter { pid in
            pid > 0 && executableContains(pid: pid, marker: xpcMarker)
        }
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
