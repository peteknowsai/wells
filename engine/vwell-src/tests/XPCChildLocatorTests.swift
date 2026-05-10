import Testing
import Foundation
import Darwin
@testable import lume

@Suite("XPCChildLocator")
struct XPCChildLocatorTests {
    @Test("isAlive returns true for current process, false for non-existent PID")
    func isAliveBasic() {
        #expect(XPCChildLocator.isAlive(pid: getpid()) == true)
        // PID 1 (launchd) is always alive on macOS, but kill(0) may
        // return EPERM there for non-root callers — our isAlive treats
        // EPERM as "alive but unreachable" which is correct for sweep
        // purposes. So just check that it's reported alive.
        #expect(XPCChildLocator.isAlive(pid: 1) == true)
        // PID 999999 effectively never exists.
        #expect(XPCChildLocator.isAlive(pid: 999_999) == false)
    }

    @Test("executableContains matches our own swift-test process binary")
    func executableMatch() {
        // Test self-introspection. Our executable contains "lume" (or
        // at least "swift-frontend"/"xctest" in test runs) in its
        // path. The marker will match if it's a substring of the
        // executable path. Use a marker we know is in any swift-built
        // binary's path: "/" — guaranteed to appear in any abs path.
        #expect(XPCChildLocator.executableContains(pid: getpid(), marker: "/") == true)
        // And a marker that won't match the test runner.
        #expect(
            XPCChildLocator.executableContains(
                pid: getpid(),
                marker: "Virtualization.VirtualMachine"
            ) == false
        )
    }

    @Test("executableContains returns false for non-existent PID")
    func executableMissingPid() {
        #expect(
            XPCChildLocator.executableContains(pid: 999_999, marker: "anything") == false
        )
    }

    @Test("findAllVMProcesses returns an array (possibly empty)")
    func findAllProcesses() {
        // We can't reliably assert what's running on the test host. Just
        // verify the call returns without crashing and that any results
        // are PIDs of processes whose executable matches our marker.
        let pids = XPCChildLocator.findAllVMProcesses()
        for pid in pids {
            #expect(pid > 0)
            #expect(
                XPCChildLocator.executableContains(
                    pid: pid, marker: XPCChildLocator.xpcMarker
                ) == true
            )
        }
    }
}
