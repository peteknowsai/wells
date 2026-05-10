import Testing
import Foundation
@testable import lume

@Suite("VNCSession Codable")
struct VNCSessionTests {
    @Test("round-trips with xpcPid")
    func roundtripsWithPid() throws {
        let original = VNCSession(
            url: "vnc://:secret@127.0.0.1:5901",
            sharedDirectories: nil,
            xpcPid: 12345
        )
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(VNCSession.self, from: data)
        #expect(decoded.url == original.url)
        #expect(decoded.xpcPid == 12345)
    }

    @Test("round-trips without xpcPid (nil)")
    func roundtripsWithoutPid() throws {
        let original = VNCSession(url: "vnc://:secret@127.0.0.1:5902")
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(VNCSession.self, from: data)
        #expect(decoded.url == original.url)
        #expect(decoded.xpcPid == nil)
    }

    @Test("decodes legacy session JSON without xpcPid field")
    func decodesLegacyJson() throws {
        // Old session files written by the previous lume serve don't have
        // the xpcPid field. They must still load — orphan-sweep treats
        // nil xpcPid as "ambiguous" and conservatively just clears the
        // session without killing any process.
        let legacy = """
            {
              "url": "vnc://:pwd@127.0.0.1:5903",
              "sharedDirectories": null
            }
            """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(VNCSession.self, from: legacy)
        #expect(decoded.url == "vnc://:pwd@127.0.0.1:5903")
        #expect(decoded.xpcPid == nil)
    }
}
