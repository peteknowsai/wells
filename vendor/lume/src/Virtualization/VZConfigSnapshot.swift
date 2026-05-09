import Foundation
import Virtualization

// wells: hibernation diagnostic. Apple's restoreMachineStateFrom returns
// an opaque "invalid argument" when the restore-time VZ device graph
// differs in any structural way from what was saved. Bundle metadata
// (config.json) covers CPU/memory/MAC/cidata; it does NOT cover the
// devices lume auto-adds in Swift (audio, USB controller, Spice
// clipboard console, Rosetta share, lume-config tmp share, balloon,
// entropy, etc.). Those are the suspects.
//
// Approach (per cells team 2026-05-09):
//   - Snapshot the effective VZVirtualMachineConfiguration at
//     save time, persist next to hibernate.bin.
//   - At restore time, build the fresh config, snapshot it, diff
//     against the saved snapshot, and FAIL FAST with the field-level
//     diff if anything drifted — without calling Apple. Apple's
//     "invalid argument" is opaque; this turns it into "audio.0.source
//     drifted from VZHostAudioInputStreamSource to nil" (or whatever).
//   - If the snapshots match and Apple still rejects restore, the
//     problem is a non-serializable runtime host object, not visible
//     structural drift — call out next debug step.
//
// Snapshot uses string fingerprints rather than full reconstruction:
// VZ types aren't Codable, and the goal is detecting drift, not
// reconstructing the graph.
struct VZConfigSnapshot: Codable, Equatable {
    let label: String
    let timestamp: String
    let cpuCount: Int
    let memorySizeBytes: UInt64
    let bootLoader: String
    let platform: String
    let platformNestedVirtualization: String
    let storageDevices: [String]
    let networkDevices: [String]
    let directorySharingDevices: [String]
    let audioDevices: [String]
    let graphicsDevices: [String]
    let keyboards: [String]
    let pointingDevices: [String]
    let consoleDevices: [String]
    let entropyDevices: [String]
    let memoryBalloonDevices: [String]
    let usbControllers: [String]
}

@MainActor
enum VZConfigDiagnostic {
    // Build a snapshot of the effective VZ device graph. String
    // fingerprints — class names + the few fields that materially
    // shape the device (paths, MACs, tags, readOnly).
    static func capture(_ vz: VZVirtualMachineConfiguration, label: String) -> VZConfigSnapshot {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let timestamp = formatter.string(from: Date())

        let bootLoader = describeBootLoader(vz.bootLoader)
        let platformName = String(describing: type(of: vz.platform))
        var nestedVirt = "n/a"
        if #available(macOS 15, *), let gp = vz.platform as? VZGenericPlatformConfiguration {
            nestedVirt = gp.isNestedVirtualizationEnabled ? "true" : "false"
        }

        let storage = vz.storageDevices.map(describeStorageDevice)
        let network = vz.networkDevices.map(describeNetworkDevice)
        let dirShares = vz.directorySharingDevices.map(describeDirectoryShare)
        let audio = vz.audioDevices.map(describeAudioDevice)
        let graphics = vz.graphicsDevices.map(describeGraphicsDevice)
        let keyboards = vz.keyboards.map { String(describing: type(of: $0)) }
        let pointing = vz.pointingDevices.map { String(describing: type(of: $0)) }
        let console = vz.consoleDevices.map(describeConsoleDevice)
        let entropy = vz.entropyDevices.map { String(describing: type(of: $0)) }
        let balloon = vz.memoryBalloonDevices.map { String(describing: type(of: $0)) }
        var usb: [String] = []
        if #available(macOS 15, *) {
            usb = vz.usbControllers.map { String(describing: type(of: $0)) }
        }

        return VZConfigSnapshot(
            label: label,
            timestamp: timestamp,
            cpuCount: vz.cpuCount,
            memorySizeBytes: vz.memorySize,
            bootLoader: bootLoader,
            platform: platformName,
            platformNestedVirtualization: nestedVirt,
            storageDevices: storage,
            networkDevices: network,
            directorySharingDevices: dirShares,
            audioDevices: audio,
            graphicsDevices: graphics,
            keyboards: keyboards,
            pointingDevices: pointing,
            consoleDevices: console,
            entropyDevices: entropy,
            memoryBalloonDevices: balloon,
            usbControllers: usb)
    }

    static func write(_ snapshot: VZConfigSnapshot, to fileURL: URL) {
        do {
            let parent = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: parent, withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(snapshot)
            try data.write(to: fileURL)
            Logger.info(
                "Wrote VZ config snapshot",
                metadata: ["label": snapshot.label, "path": fileURL.path])
        } catch {
            Logger.info(
                "Failed to write VZ config snapshot: \(error.localizedDescription)",
                metadata: ["label": snapshot.label, "path": fileURL.path])
        }
    }

    static func load(from fileURL: URL) -> VZConfigSnapshot? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(VZConfigSnapshot.self, from: data)
    }

    // Per-field diff. Returns the human-readable list of drift lines.
    // Empty array means "snapshots match" — caller can call Apple.
    static func diff(saved a: VZConfigSnapshot, restored b: VZConfigSnapshot) -> [String] {
        var lines: [String] = []
        if a.cpuCount != b.cpuCount {
            lines.append("cpuCount: \(a.cpuCount) → \(b.cpuCount)")
        }
        if a.memorySizeBytes != b.memorySizeBytes {
            lines.append("memorySizeBytes: \(a.memorySizeBytes) → \(b.memorySizeBytes)")
        }
        if a.bootLoader != b.bootLoader {
            lines.append("bootLoader: \(a.bootLoader) → \(b.bootLoader)")
        }
        if a.platform != b.platform {
            lines.append("platform: \(a.platform) → \(b.platform)")
        }
        if a.platformNestedVirtualization != b.platformNestedVirtualization {
            lines.append(
                "platformNestedVirtualization: \(a.platformNestedVirtualization) → \(b.platformNestedVirtualization)")
        }
        appendArrayDiff(a.storageDevices, b.storageDevices, "storageDevices", into: &lines)
        appendArrayDiff(a.networkDevices, b.networkDevices, "networkDevices", into: &lines)
        appendArrayDiff(
            a.directorySharingDevices, b.directorySharingDevices,
            "directorySharingDevices", into: &lines)
        appendArrayDiff(a.audioDevices, b.audioDevices, "audioDevices", into: &lines)
        appendArrayDiff(a.graphicsDevices, b.graphicsDevices, "graphicsDevices", into: &lines)
        appendArrayDiff(a.keyboards, b.keyboards, "keyboards", into: &lines)
        appendArrayDiff(a.pointingDevices, b.pointingDevices, "pointingDevices", into: &lines)
        appendArrayDiff(a.consoleDevices, b.consoleDevices, "consoleDevices", into: &lines)
        appendArrayDiff(a.entropyDevices, b.entropyDevices, "entropyDevices", into: &lines)
        appendArrayDiff(
            a.memoryBalloonDevices, b.memoryBalloonDevices, "memoryBalloonDevices", into: &lines)
        appendArrayDiff(a.usbControllers, b.usbControllers, "usbControllers", into: &lines)
        return lines
    }

    private static func appendArrayDiff(
        _ a: [String], _ b: [String], _ field: String, into lines: inout [String]
    ) {
        if a == b { return }
        if a.count != b.count {
            lines.append("\(field).count: \(a.count) → \(b.count)")
            lines.append("  saved: \(a)")
            lines.append("  restored: \(b)")
            return
        }
        for (i, (av, bv)) in zip(a, b).enumerated() where av != bv {
            lines.append("\(field)[\(i)]: \(av) → \(bv)")
        }
    }

    // MARK: - device fingerprinters

    private static func describeBootLoader(_ bl: VZBootLoader?) -> String {
        guard let bl = bl else { return "<nil>" }
        if let efi = bl as? VZEFIBootLoader {
            let varStore = efi.variableStore?.url.path ?? "<nil>"
            return "VZEFIBootLoader(variableStore=\(varStore))"
        }
        return String(describing: type(of: bl))
    }

    private static func describeStorageDevice(_ dev: VZStorageDeviceConfiguration) -> String {
        let typeName = String(describing: type(of: dev))
        if let attach = dev.attachment as? VZDiskImageStorageDeviceAttachment {
            return
                "\(typeName)(path=\(attach.url.path),readOnly=\(attach.isReadOnly),caching=\(attach.cachingMode.rawValue),sync=\(attach.synchronizationMode.rawValue))"
        }
        return typeName
    }

    private static func describeNetworkDevice(_ dev: VZNetworkDeviceConfiguration) -> String {
        let typeName = String(describing: type(of: dev))
        let mac = dev.macAddress.string
        let attachType: String
        if dev.attachment is VZNATNetworkDeviceAttachment {
            attachType = "NAT"
        } else if let bridged = dev.attachment as? VZBridgedNetworkDeviceAttachment {
            attachType = "Bridged(\(bridged.interface.identifier))"
        } else if let a = dev.attachment {
            attachType = String(describing: type(of: a))
        } else {
            attachType = "<nil>"
        }
        return "\(typeName)(mac=\(mac),attach=\(attachType))"
    }

    private static func describeDirectoryShare(_ dev: VZDirectorySharingDeviceConfiguration)
        -> String
    {
        let typeName = String(describing: type(of: dev))
        guard let fs = dev as? VZVirtioFileSystemDeviceConfiguration else {
            return typeName
        }
        let tag = fs.tag
        guard let share = fs.share else {
            return "\(typeName)(tag=\(tag),share=<nil>)"
        }
        if let single = share as? VZSingleDirectoryShare {
            return
                "\(typeName)(tag=\(tag),hostPath=\(single.directory.url.path),readOnly=\(single.directory.isReadOnly))"
        }
        if #available(macOS 13, *), share is VZLinuxRosettaDirectoryShare {
            return "\(typeName)(tag=\(tag),share=Rosetta)"
        }
        return "\(typeName)(tag=\(tag),share=\(String(describing: type(of: share))))"
    }

    private static func describeAudioDevice(_ dev: VZAudioDeviceConfiguration) -> String {
        let typeName = String(describing: type(of: dev))
        guard let snd = dev as? VZVirtioSoundDeviceConfiguration else {
            return typeName
        }
        let streams = snd.streams.map { stream -> String in
            let s = String(describing: type(of: stream))
            if let inp = stream as? VZVirtioSoundDeviceInputStreamConfiguration {
                let src = inp.source.map { String(describing: type(of: $0)) } ?? "<nil>"
                return "\(s)(source=\(src))"
            }
            if let out = stream as? VZVirtioSoundDeviceOutputStreamConfiguration {
                let sink = out.sink.map { String(describing: type(of: $0)) } ?? "<nil>"
                return "\(s)(sink=\(sink))"
            }
            return s
        }
        return "\(typeName)(streams=[\(streams.joined(separator: ","))])"
    }

    private static func describeGraphicsDevice(_ dev: VZGraphicsDeviceConfiguration) -> String {
        let typeName = String(describing: type(of: dev))
        if let g = dev as? VZVirtioGraphicsDeviceConfiguration {
            let scanouts = g.scanouts.map { "\($0.widthInPixels)x\($0.heightInPixels)" }
            return "\(typeName)(scanouts=[\(scanouts.joined(separator: ","))])"
        }
        return typeName
    }

    private static func describeConsoleDevice(_ dev: VZConsoleDeviceConfiguration) -> String {
        let typeName = String(describing: type(of: dev))
        guard let c = dev as? VZVirtioConsoleDeviceConfiguration else {
            return typeName
        }
        var portNames: [String] = []
        // VZVirtioConsolePortConfigurationArray supports subscript by
        // index up to maximumPortCount; collect names of populated
        // ports.
        for i in 0..<Int(c.ports.maximumPortCount) {
            if let port = c.ports[i], let name = port.name {
                portNames.append("\(i)=\(name)")
            }
        }
        return "\(typeName)(ports=[\(portNames.joined(separator: ","))])"
    }
}
