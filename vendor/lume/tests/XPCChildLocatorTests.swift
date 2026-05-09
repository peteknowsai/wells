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

    @Test("scanOnce returns nil when we have no VZ children")
    func scanWithoutVMs() {
        // Test process has no VirtualMachine.xpc children. scanOnce
        // should return nil (or a very small value if launchd has
        // adopted some — but that's not our PID's children).
        #expect(XPCChildLocator.scanOnce() == nil)
    }
}
