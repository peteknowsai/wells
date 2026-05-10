import Foundation
import Testing

@testable import lume

// wells: regression canary for the cidata mount path. Cells team caught
// 2026-05-09 that POST /lume/vms/{name}/run was silently ignoring the
// `mount` field, because the patch that added `let mount: String?` to
// RunVMRequest got lost during the patches→source transition (commit
// b5287ad). Symptom: every fresh fork booted without cidata, kept the
// bake-time identity, never authorized the per-well SSH key. Three
// hours of debugging "weird DHCP" before tracing it back here.
//
// These tests pin the contract: `mount` must decode, must round-trip
// nil when absent, and a default-constructed RunVMRequest must accept
// nil mount. If anyone removes the field again the suite goes red.
@Suite("RunVMRequest mount field")
struct RunVMRequestTests {
    @Test("mount field decodes from JSON body")
    func decodesMountField() throws {
        let json = #"""
            {"noDisplay": true, "mount": "/Users/pete/.wells/vms/foo/cidata.iso"}
            """#.data(using: .utf8)!
        let req = try JSONDecoder().decode(RunVMRequest.self, from: json)
        #expect(req.noDisplay == true)
        #expect(req.mount == "/Users/pete/.wells/vms/foo/cidata.iso")
    }

    @Test("absent mount decodes as nil")
    func absentMountIsNil() throws {
        let json = #"""
            {"noDisplay": true}
            """#.data(using: .utf8)!
        let req = try JSONDecoder().decode(RunVMRequest.self, from: json)
        #expect(req.mount == nil)
    }

    @Test("default-constructed request accepts nil mount")
    func defaultConstructorAcceptsNilMount() {
        let req = RunVMRequest(
            noDisplay: nil, sharedDirectories: nil, recoveryMode: nil, storage: nil,
            diskPath: nil, nvramPath: nil, network: nil, clipboard: nil, mount: nil)
        #expect(req.mount == nil)
    }
}
