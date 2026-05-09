import Foundation
import CoreGraphics
import Virtualization

// MARK: - Support Types

/// Base context for virtual machine directory and configuration
struct VMDirContext {
    let dir: VMDirectory
    var config: VMConfig
    let home: Home
    let storage: String?

    /// Optional override paths for disk and nvram files.
    /// When set, these take precedence over the default directory-based paths.
    /// This allows external tools (e.g. lumelet) to point lume at files
    /// stored outside the standard VM directory layout.
    var diskPathOverride: Path?
    var nvramPathOverride: Path?

    func saveConfig() throws {
        try dir.saveConfig(config)
    }

    var name: String { dir.name }
    var initialized: Bool { dir.initialized() }
    var diskPath: Path { diskPathOverride ?? dir.diskPath }
    var nvramPath: Path { nvramPathOverride ?? dir.nvramPath }

    func setDisk(_ size: UInt64) throws {
        try dir.setDisk(size)
    }

    func finalize(to name: String) throws {
        let vmDir = try home.getVMDirectory(name)
        try FileManager.default.moveItem(at: dir.dir.url, to: vmDir.dir.url)
    }
}

// MARK: - Base VM Class

/// Base class for virtual machine implementations
@MainActor
class VM {
    // MARK: - Properties

    var vmDirContext: VMDirContext

    @MainActor
    private var virtualizationService: VMVirtualizationService?
    internal let vncService: VNCService
    private var clipboardWatcher: ClipboardWatcher?
    internal let virtualizationServiceFactory:
        (VMVirtualizationServiceContext) throws -> VMVirtualizationService
    private let vncServiceFactory: (VMDirectory) -> VNCService

    // MARK: - Initialization

    init(
        vmDirContext: VMDirContext,
        virtualizationServiceFactory: @escaping (VMVirtualizationServiceContext) throws ->
            VMVirtualizationService = { try DarwinVirtualizationService(configuration: $0) },
        vncServiceFactory: @escaping (VMDirectory) -> VNCService = {
            DefaultVNCService(vmDirectory: $0)
        }
    ) {
        self.vmDirContext = vmDirContext
        self.virtualizationServiceFactory = virtualizationServiceFactory
        self.vncServiceFactory = vncServiceFactory

        // Initialize VNC service
        self.vncService = vncServiceFactory(vmDirContext.dir)
    }

    // MARK: - Public Accessors

    /// The VM name
    var name: String { vmDirContext.name }

    /// The VM configuration
    var config: VMConfig { vmDirContext.config }

    // MARK: - VM State Management

    private var isRunning: Bool {
        // First check if we have a MAC address
        guard let macAddress = vmDirContext.config.macAddress else {
            Logger.info(
                "Cannot check if VM is running: macAddress is nil",
                metadata: ["name": vmDirContext.name])
            return false
        }

        // Then check if we have an IP address
        guard let ipAddress = DHCPLeaseParser.getIPAddress(forMAC: macAddress) else {
            return false
        }

        // Then check if it's reachable
        return NetworkUtils.isReachable(ipAddress: ipAddress)
    }

    var details: VMDetails {
        let isRunning: Bool = self.isRunning
        let vncUrl = isRunning ? getVNCUrl() : nil

        // Safely get disk size with fallback
        let diskSizeValue: DiskSize
        do {
            diskSizeValue = try getDiskSize()
        } catch {
            Logger.error(
                "Failed to get disk size",
                metadata: ["name": vmDirContext.name, "error": "\(error)"])
            // Provide a fallback value to avoid crashing
            diskSizeValue = DiskSize(allocated: 0, total: vmDirContext.config.diskSize ?? 0)
        }

        // Safely access MAC address
        let macAddress = vmDirContext.config.macAddress
        let ipAddress: String? =
            isRunning && macAddress != nil ? DHCPLeaseParser.getIPAddress(forMAC: macAddress!) : nil

        // Check if SSH is available (only if we have an IP)
        let sshAvailable: Bool? = ipAddress != nil ? NetworkUtils.isSSHAvailable(ipAddress: ipAddress!) : nil

        return VMDetails(
            name: vmDirContext.name,
            os: getOSType(),
            cpuCount: vmDirContext.config.cpuCount ?? 0,
            memorySize: vmDirContext.config.memorySize ?? 0,
            diskSize: diskSizeValue,
            display: vmDirContext.config.display.string,
            status: isRunning ? "running" : "stopped",
            vncUrl: vncUrl,
            ipAddress: ipAddress,
            sshAvailable: sshAvailable,
            locationName: vmDirContext.storage ?? "home",
            networkMode: vmDirContext.config.networkMode.description
        )
    }

    // MARK: - VM Lifecycle Management

    func run(
        noDisplay: Bool, sharedDirectories: [SharedDirectory], mount: Path?, vncPort: Int = 0,
        vncPassword: String? = nil, recoveryMode: Bool = false, usbMassStoragePaths: [Path]? = nil,
        networkMode: NetworkMode? = nil, clipboard: Bool = false
    ) async throws {
        Logger.info(
            "VM.run method called",
            metadata: [
                "name": vmDirContext.name,
                "noDisplay": "\(noDisplay)",
                "recoveryMode": "\(recoveryMode)",
            ])

        guard vmDirContext.initialized else {
            Logger.error("VM not initialized", metadata: ["name": vmDirContext.name])
            throw VMError.notInitialized(vmDirContext.name)
        }

        guard let cpuCount = vmDirContext.config.cpuCount,
            let memorySize = vmDirContext.config.memorySize
        else {
            Logger.error("VM missing cpuCount or memorySize", metadata: ["name": vmDirContext.name])
            throw VMError.notInitialized(vmDirContext.name)
        }

        // Try to acquire lock on config file
        Logger.info(
            "Attempting to acquire lock on config file",
            metadata: [
                "path": vmDirContext.dir.configPath.path,
                "name": vmDirContext.name,
            ])
        var fileHandle = try FileHandle(forWritingTo: vmDirContext.dir.configPath.url)

        if flock(fileHandle.fileDescriptor, LOCK_EX | LOCK_NB) != 0 {
            try? fileHandle.close()
            Logger.error(
                "VM already running (failed to acquire lock)", metadata: ["name": vmDirContext.name]
            )

            // Try to forcibly clear the lock before giving up
            Logger.info("Attempting emergency lock cleanup", metadata: ["name": vmDirContext.name])
            unlockConfigFile()

            // Try one more time to acquire the lock
            if let retryHandle = try? FileHandle(forWritingTo: vmDirContext.dir.configPath.url),
                flock(retryHandle.fileDescriptor, LOCK_EX | LOCK_NB) == 0
            {
                Logger.info("Emergency lock cleanup worked", metadata: ["name": vmDirContext.name])
                // Continue with a fresh file handle
                try? retryHandle.close()
                // Get a completely new file handle to be safe
                guard let newHandle = try? FileHandle(forWritingTo: vmDirContext.dir.configPath.url)
                else {
                    throw VMError.internalError("Failed to open file handle after lock cleanup")
                }
                // Update our main file handle
                fileHandle = newHandle
            } else {
                // If we still can't get the lock, give up
                Logger.error(
                    "Could not acquire lock even after emergency cleanup",
                    metadata: ["name": vmDirContext.name])
                throw VMError.alreadyRunning(vmDirContext.name)
            }
        }
        Logger.info("Successfully acquired lock", metadata: ["name": vmDirContext.name])

        Logger.info(
            "Running VM with configuration",
            metadata: [
                "name": vmDirContext.name,
                "cpuCount": "\(cpuCount)",
                "memorySize": "\(memorySize)",
                "diskSize": "\(vmDirContext.config.diskSize ?? 0)",
                "sharedDirectories": sharedDirectories.map { $0.string }.joined(separator: ", "),
                "recoveryMode": "\(recoveryMode)",
            ])

        // Create and configure the VM
        do {
            // Create a lume-config shared directory so the guest can discover
            // the VNC port/password at boot.  The directory is created empty now
            // and populated after the VNC server starts (VirtioFS exposes live
            // host directory contents, so the guest will see the file once written).
            let lumeConfigDir = FileManager.default.temporaryDirectory
                .appendingPathComponent("lume-config-\(vmDirContext.name)")
            try? FileManager.default.createDirectory(at: lumeConfigDir, withIntermediateDirectories: true)
            // Remove stale vnc.env from a previous run so the guest doesn't
            // read outdated port/password before the new file is written.
            try? FileManager.default.removeItem(
                at: lumeConfigDir.appendingPathComponent("vnc.env"))
            let lumeConfigSharedDir = SharedDirectory(
                hostPath: lumeConfigDir.path, tag: "lume-config", readOnly: true)
            var allSharedDirectories = sharedDirectories
            allSharedDirectories.append(lumeConfigSharedDir)

            Logger.info(
                "Creating virtualization service context", metadata: ["name": vmDirContext.name])
            let config = try createVMVirtualizationServiceContext(
                cpuCount: cpuCount,
                memorySize: memorySize,
                display: vmDirContext.config.display.string,
                sharedDirectories: allSharedDirectories,
                mount: mount,
                recoveryMode: recoveryMode,
                usbMassStoragePaths: usbMassStoragePaths,
                networkMode: networkMode,
                headless: noDisplay
            )
            Logger.info(
                "Successfully created virtualization service context",
                metadata: ["name": vmDirContext.name])

            Logger.info(
                "Initializing virtualization service", metadata: ["name": vmDirContext.name])
            virtualizationService = try virtualizationServiceFactory(config)
            Logger.info(
                "Successfully initialized virtualization service",
                metadata: ["name": vmDirContext.name])

            Logger.info(
                "Setting up VNC",
                metadata: [
                    "name": vmDirContext.name,
                    "noDisplay": "\(noDisplay)",
                    "port": "\(vncPort)",
                ])
            let vncInfo = try await setupSession(
                port: vncPort, password: vncPassword, sharedDirectories: sharedDirectories)

            // Parse VNC port and password from the VNC URL for config distribution.
            // URL format: vnc://:password@host:port — URLComponents needs http:// to parse correctly.
            var vncPortValue: Int?
            var vncPasswordValue: String?
            if let components = URLComponents(string: vncInfo.replacingOccurrences(of: "vnc://", with: "http://")),
               let port = components.port {
                vncPortValue = port
                vncPasswordValue = components.password ?? ""
                let envContent = "VNC_PORT=\(port)\nVNC_PASSWORD=\(vncPasswordValue!)\n"
                try? envContent.write(
                    to: lumeConfigDir.appendingPathComponent("vnc.env"),
                    atomically: true, encoding: .utf8)
                Logger.info("Wrote VNC config to shared directory", metadata: [
                    "port": "\(port)", "path": lumeConfigDir.path])
            }
            Logger.info(
                "VNC setup successful", metadata: ["name": vmDirContext.name, "vncInfo": vncInfo])

            // Start the VM
            guard let service = virtualizationService else {
                Logger.error("Virtualization service is nil", metadata: ["name": vmDirContext.name])
                throw VMError.internalError("Virtualization service not initialized")
            }
            Logger.info(
                "Starting VM via virtualization service", metadata: ["name": vmDirContext.name])
            try await service.start()
            Logger.info("VM started successfully", metadata: ["name": vmDirContext.name])

            // B.0.6: orphan sweep at lume startup nukes ALL existing
            // VirtualMachine.xpc processes — no per-VM PID capture
            // needed. The xpcPid field on VNCSession is now unused
            // metadata; kept on the struct for forward compat in case
            // we want a finer-grained "kill only this VM's child"
            // operation later.

            // Open the VNC client only after VM start to avoid connecting to an empty framebuffer.
            if !noDisplay {
                await waitForVisibleFramebufferBeforeOpeningClient()
                Logger.info("Starting VNC session", metadata: ["name": vmDirContext.name])
                try await vncService.openClient(url: vncInfo)
            }

            // Write VNC config into VM via SSH (background task).
            // VirtioFS mounts are blocked by macOS TCC for LaunchAgent processes,
            // so we also write vnc.env directly to the guest's home directory.
            if let port = vncPortValue, let password = vncPasswordValue {
                let vmName = vmDirContext.name
                let storage = vmDirContext.storage
                Task.detached {
                    await VM.writeVNCConfigViaSSH(
                        vmName: vmName, storage: storage, port: port, password: password)
                }
            }

            // Start clipboard watcher for automatic host-to-VM clipboard sync
            // Requires SSH/Remote Login to be enabled on the VM
            if clipboard {
                clipboardWatcher = ClipboardWatcher(vmName: vmDirContext.name, storage: vmDirContext.storage)
                await clipboardWatcher?.start()
            }

            while true {
                try await Task.sleep(nanoseconds: UInt64(1e9))
            }
        } catch {
            Logger.error(
                "Failed in VM.run",
                metadata: [
                    "name": vmDirContext.name,
                    "error": error.localizedDescription,
                    "errorType": "\(type(of: error))",
                ])
            await clipboardWatcher?.stop()
            clipboardWatcher = nil
            virtualizationService = nil
            vncService.stop()

            // Release lock
            Logger.info("Releasing file lock after error", metadata: ["name": vmDirContext.name])
            flock(fileHandle.fileDescriptor, LOCK_UN)
            try? fileHandle.close()

            // Additionally, perform our aggressive unlock to ensure no locks remain
            Logger.info(
                "Performing additional lock cleanup after error",
                metadata: ["name": vmDirContext.name])
            unlockConfigFile()

            throw error
        }
    }

    @MainActor
    func stop() async throws {
        guard vmDirContext.initialized else {
            throw VMError.notInitialized(vmDirContext.name)
        }

        Logger.info("Attempting to stop VM", metadata: ["name": vmDirContext.name])

        // If we have a virtualization service, try to stop it cleanly first
        if let service = virtualizationService {
            do {
                Logger.info(
                    "Stopping VM via virtualization service", metadata: ["name": vmDirContext.name])
                try await service.stop()
                await clipboardWatcher?.stop()
                clipboardWatcher = nil
                virtualizationService = nil
                vncService.stop()
                Logger.info(
                    "VM stopped successfully via virtualization service",
                    metadata: ["name": vmDirContext.name])

                // Try to ensure any existing locks are released
                Logger.info(
                    "Attempting to clear any locks on config file",
                    metadata: ["name": vmDirContext.name])
                unlockConfigFile()

                return
            } catch let error {
                Logger.error(
                    "Failed to stop VM via virtualization service",
                    metadata: [
                        "name": vmDirContext.name,
                        "error": error.localizedDescription,
                    ])
                // Fall through to process termination
            }
        }

        // Try to open config file to get file descriptor
        Logger.info(
            "Attempting to access config file lock",
            metadata: [
                "path": vmDirContext.dir.configPath.path,
                "name": vmDirContext.name,
            ])
        let fileHandle = try? FileHandle(forReadingFrom: vmDirContext.dir.configPath.url)
        guard let fileHandle = fileHandle else {
            Logger.info(
                "Failed to open config file - VM may not be running",
                metadata: ["name": vmDirContext.name])

            // Even though we couldn't open the file, try to force unlock anyway
            unlockConfigFile()

            throw VMError.notRunning(vmDirContext.name)
        }

        // Get the PID of the process holding the lock using lsof command
        Logger.info(
            "Finding process holding lock on config file", metadata: ["name": vmDirContext.name])
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        task.arguments = ["-F", "p", vmDirContext.dir.configPath.path]

        let outputPipe = Pipe()
        task.standardOutput = outputPipe

        try task.run()
        task.waitUntilExit()

        let outputData = try outputPipe.fileHandleForReading.readToEnd() ?? Data()
        guard let outputString = String(data: outputData, encoding: .utf8),
            let pidString = outputString.split(separator: "\n").first?.dropFirst(),  // Drop the 'p' prefix
            let pid = pid_t(pidString)
        else {
            try? fileHandle.close()
            Logger.info(
                "Failed to find process holding lock - VM may not be running",
                metadata: ["name": vmDirContext.name])

            // Even though we couldn't find the process, try to force unlock
            unlockConfigFile()

            throw VMError.notRunning(vmDirContext.name)
        }

        Logger.info(
            "Found process \(pid) holding lock on config file",
            metadata: ["name": vmDirContext.name])

        // First try graceful shutdown with SIGINT
        if kill(pid, SIGINT) == 0 {
            Logger.info("Sent SIGINT to VM process \(pid)", metadata: ["name": vmDirContext.name])
        }

        // Wait for process to stop with timeout
        var attempts = 0
        while attempts < 10 {
            Logger.info(
                "Waiting for process \(pid) to terminate (attempt \(attempts + 1)/10)",
                metadata: ["name": vmDirContext.name])
            try await Task.sleep(nanoseconds: 1_000_000_000)

            // Check if process still exists
            if kill(pid, 0) != 0 {
                // Process is gone, do final cleanup
                Logger.info("Process \(pid) has terminated", metadata: ["name": vmDirContext.name])
                virtualizationService = nil
                vncService.stop()
                try? fileHandle.close()

                // Force unlock the config file
                unlockConfigFile()

                Logger.info(
                    "VM stopped successfully via process termination",
                    metadata: ["name": vmDirContext.name])
                return
            }
            attempts += 1
        }

        // If graceful shutdown failed, force kill the process
        Logger.info(
            "Graceful shutdown failed, forcing termination of process \(pid)",
            metadata: ["name": vmDirContext.name])
        if kill(pid, SIGKILL) == 0 {
            Logger.info("Sent SIGKILL to process \(pid)", metadata: ["name": vmDirContext.name])

            // Wait a moment for the process to be fully killed
            try await Task.sleep(nanoseconds: 2_000_000_000)

            // Do final cleanup
            virtualizationService = nil
            vncService.stop()
            try? fileHandle.close()

            // Force unlock the config file
            unlockConfigFile()

            Logger.info("VM forcefully stopped", metadata: ["name": vmDirContext.name])
            return
        }

        // If we get here, something went very wrong
        try? fileHandle.close()
        Logger.error(
            "Failed to stop VM - could not terminate process \(pid)",
            metadata: ["name": vmDirContext.name])

        // As a last resort, try to force unlock
        unlockConfigFile()

        throw VMError.internalError("Failed to stop VM process")
    }

    // wells: hot-tier support — pause/resume keep the VM alive (CPU
    // halted, memory resident). Unlike stop, we don't tear down
    // virtualizationService; resume just unpauses the same instance.
    func pause() async throws {
        guard vmDirContext.initialized else {
            throw VMError.notInitialized(vmDirContext.name)
        }
        guard let service = virtualizationService else {
            throw VMError.notRunning(vmDirContext.name)
        }
        Logger.info("Pausing VM", metadata: ["name": vmDirContext.name])
        try await service.pause()
        Logger.info("VM paused", metadata: ["name": vmDirContext.name])
    }

    func resume() async throws {
        guard vmDirContext.initialized else {
            throw VMError.notInitialized(vmDirContext.name)
        }
        guard let service = virtualizationService else {
            throw VMError.notRunning(vmDirContext.name)
        }
        Logger.info("Resuming VM", metadata: ["name": vmDirContext.name])
        try await service.resume()
        Logger.info("VM resumed", metadata: ["name": vmDirContext.name])
    }

    // wells: hibernation — write running state to disk so RAM can be
    // reclaimed. Apple requires the VM be paused before save; we do
    // that here so callers don't have to remember the dance. After
    // saveState the VM is `.stopped` and the file is durable.
    //
    // The output file path is caller-supplied so wells can keep state
    // alongside its bundle dir (well-managed location, gets cleaned
    // up by destroy).
    func saveState(to fileURL: URL) async throws {
        guard vmDirContext.initialized else {
            throw VMError.notInitialized(vmDirContext.name)
        }
        guard let service = virtualizationService else {
            throw VMError.notRunning(vmDirContext.name)
        }
        Logger.info(
            "Saving VM state",
            metadata: ["name": vmDirContext.name, "path": fileURL.path])
        // saveMachineStateTo requires the paused state. If the VM is
        // already paused (e.g. via prior pauseVM call), this is a no-op.
        if service.state != .paused {
            try await service.pause()
        }
        // wells: B.0.9.a hibernation diagnostic. Snapshot the
        // effective VZ device graph and persist it next to hibernate.bin.
        // Restore reads it back and diffs against the rebuilt config
        // before calling Apple — turning the opaque "invalid argument"
        // into a per-field drift report.
        if let baseService = service as? BaseVirtualizationService,
           let vzConfig = baseService.cachedConfiguration {
            // Drive the headless flag from the cached context. Only
            // BaseVirtualizationService knows it (LinuxVirtualizationService
            // built the config with it). For now we infer headless from
            // the absence of audio devices — VZVirtualMachineConfiguration
            // doesn't expose the flag we passed in, but its outputs do.
            let inferredHeadless = vzConfig.audioDevices.isEmpty
            let snapshot = VZConfigDiagnostic.capture(
                vzConfig, label: "save", headless: inferredHeadless)
            VZConfigDiagnostic.write(
                snapshot, to: hibernateConfigSnapshotURL(for: fileURL))
        } else {
            Logger.info(
                "VZ config snapshot skipped — cachedConfiguration unavailable (likely reattached VM)",
                metadata: ["name": vmDirContext.name])
        }
        try await service.saveState(to: fileURL)
        // Drop the in-process VZ handle. Per Apple docs,
        // saveMachineStateTo leaves the VM in `.paused`, and
        // restoreMachineStateFrom requires `.stopped`. There's no
        // public API to transition paused → stopped on a live VZ
        // instance, so reusing the handle for restore is structurally
        // impossible (proven empirically 2026-05-09 — Apple errors
        // "Invalid virtual machine state transition. Transition from
        // state 'paused' to state 'restoring' is invalid"). Drop the
        // handle, let restoreState build a fresh `.stopped` instance.
        // The remaining "storage device attachment is invalid" error
        // on the fresh-build path is solved by disk-only steady-state
        // hibernation (B.0.9.d.2) — eject cidata before save.
        virtualizationService = nil
        vncService.stop()
        Logger.info(
            "VM state saved",
            metadata: ["name": vmDirContext.name, "path": fileURL.path])
    }

    // wells: hibernation — restore from a previously-saved state file
    // and resume execution. Builds a fresh VZ instance from the bundle
    // config (must match what was saved), calls restoreMachineStateFrom
    // (which itself transitions VM to paused), then resumes to running.
    //
    // The `mount` parameter MUST match what the VM had at save time —
    // VZ's restoreMachineStateFrom rejects "Invalid virtual machine
    // configuration. The storage device attachment is invalid" if the
    // device shape differs from the saved state. For wells, that's
    // always the cidata.iso the cell booted with; welld threads it
    // through on wake.
    //
    // This is the "wake from frozen" path. Cell continues from exactly
    // where saveState was called — agent context, in-flight TCP
    // connections, mounted FS state all preserved.
    func restoreState(from fileURL: URL, mount: Path? = nil) async throws {
        guard vmDirContext.initialized else {
            throw VMError.notInitialized(vmDirContext.name)
        }
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            throw VMError.internalError(
                "saved state file missing: \(fileURL.path)")
        }
        Logger.info(
            "Restoring VM state",
            metadata: ["name": vmDirContext.name, "path": fileURL.path])

        guard let cpuCount = vmDirContext.config.cpuCount,
              let memorySize = vmDirContext.config.memorySize else {
            throw VMError.internalError(
                "config missing cpuCount or memorySize for restore")
        }
        // Mirror the boot path's shared-directory injection. VZ's
        // restoreMachineStateFrom rejects with "invalid argument" if
        // the device shape differs from save time — the boot path
        // appends a `lume-config` SharedDirectory for VNC env, so
        // the restore config must include it too. Cells team caught
        // this 2026-05-09: hibernate succeeded, wake returned 500.
        let lumeConfigDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("lume-config-\(vmDirContext.name)")
        try? FileManager.default.createDirectory(
            at: lumeConfigDir, withIntermediateDirectories: true)
        let lumeConfigSharedDir = SharedDirectory(
            hostPath: lumeConfigDir.path, tag: "lume-config", readOnly: true)

        // Recover the headless flag from the saved snapshot so we
        // build the same device shape Apple expects. If the snapshot
        // is missing or pre-B.0.9.b (no headless field), default to
        // true — wells is currently the only caller of save/restore
        // and is always headless. That keeps device shape stable
        // across the patched lume's lifetime.
        let savedHeadless: Bool = {
            let url = hibernateConfigSnapshotURL(for: fileURL)
            return VZConfigDiagnostic.load(from: url)?.headless ?? true
        }()
        let config = try createVMVirtualizationServiceContext(
            cpuCount: cpuCount,
            memorySize: memorySize,
            display: vmDirContext.config.display.string,
            sharedDirectories: [lumeConfigSharedDir],
            mount: mount,
            recoveryMode: false,
            usbMassStoragePaths: nil,
            headless: savedHeadless
        )
        let service = try virtualizationServiceFactory(config)
        // wells: B.0.9.a hibernation diagnostic. Before calling
        // Apple's opaque restoreMachineStateFrom, snapshot the
        // freshly-built device graph and diff it against the saved
        // snapshot. If anything drifted, throw with the field-level
        // diff — Apple will reject anyway with "invalid argument"
        // and we'd lose the signal. If snapshots match and Apple
        // still rejects, drift is in non-serializable host objects
        // (next debug step).
        let restoreSnapshotURL = hibernateConfigSnapshotURL(for: fileURL)
        if let savedSnapshot = VZConfigDiagnostic.load(from: restoreSnapshotURL),
           let baseService = service as? BaseVirtualizationService,
           let vzConfig = baseService.cachedConfiguration {
            let restored = VZConfigDiagnostic.capture(
                vzConfig, label: "restore", headless: savedHeadless)
            VZConfigDiagnostic.write(
                restored,
                to: restoreSnapshotURL.deletingLastPathComponent()
                    .appendingPathComponent("hibernate.config.restore.json"))
            let drifts = VZConfigDiagnostic.diff(saved: savedSnapshot, restored: restored)
            if drifts.isEmpty {
                Logger.info(
                    "VZ config snapshot match — drift not visible at config level",
                    metadata: ["name": vmDirContext.name])
            } else {
                Logger.error(
                    "VZ config drifted between save and restore",
                    metadata: [
                        "name": vmDirContext.name,
                        "field_count": "\(drifts.count)",
                    ])
                for line in drifts {
                    Logger.error("  drift: \(line)")
                }
                throw VMError.internalError(
                    "VZ config drifted between save and restore — "
                        + "\(drifts.count) field(s) differ. "
                        + "First: \(drifts.first ?? "(none)"). "
                        + "Snapshots: \(restoreSnapshotURL.path)")
            }
        } else {
            Logger.info(
                "VZ config diff skipped — saved snapshot or fresh config unavailable",
                metadata: ["name": vmDirContext.name])
        }
        try await service.restoreState(from: fileURL)
        try await service.resume()
        virtualizationService = service
        Logger.info(
            "VM state restored and resumed",
            metadata: ["name": vmDirContext.name])
    }

    // wells: hibernation diagnostic — snapshot lives alongside
    // hibernate.bin so it travels with the saved state and gets
    // cleaned up by destroy together. Filename: hibernate.config.json.
    private func hibernateConfigSnapshotURL(for hibernateBinURL: URL) -> URL {
        hibernateBinURL.deletingLastPathComponent()
            .appendingPathComponent("hibernate.config.json")
    }

    // Helper method to forcibly clear any locks on the config file
    private func unlockConfigFile() {
        Logger.info(
            "Forcibly clearing locks on config file",
            metadata: [
                "path": vmDirContext.dir.configPath.path,
                "name": vmDirContext.name,
            ])

        // First attempt: standard unlock methods
        if let fileHandle = try? FileHandle(forWritingTo: vmDirContext.dir.configPath.url) {
            // Use F_GETLK and F_SETLK to check and clear locks
            var lockInfo = flock()
            lockInfo.l_type = Int16(F_UNLCK)
            lockInfo.l_whence = Int16(SEEK_SET)
            lockInfo.l_start = 0
            lockInfo.l_len = 0

            // Try to unlock the file using fcntl
            _ = fcntl(fileHandle.fileDescriptor, F_SETLK, &lockInfo)

            // Also try the regular flock method
            flock(fileHandle.fileDescriptor, LOCK_UN)

            try? fileHandle.close()
            Logger.info("Standard unlock attempts performed", metadata: ["name": vmDirContext.name])
        }

        // Second attempt: try to acquire and immediately release a fresh lock
        if let tempHandle = try? FileHandle(forWritingTo: vmDirContext.dir.configPath.url) {
            if flock(tempHandle.fileDescriptor, LOCK_EX | LOCK_NB) == 0 {
                Logger.info(
                    "Successfully acquired and released lock to reset state",
                    metadata: ["name": vmDirContext.name])
                flock(tempHandle.fileDescriptor, LOCK_UN)
            } else {
                Logger.info(
                    "Could not acquire lock for resetting - may still be locked",
                    metadata: ["name": vmDirContext.name])
            }
            try? tempHandle.close()
        }

        // Third attempt (most aggressive): copy the config file, remove the original, and restore
        Logger.info(
            "Trying aggressive method: backup and restore config file",
            metadata: ["name": vmDirContext.name])
        // Only proceed if the config file exists
        let fileManager = FileManager.default
        let configPath = vmDirContext.dir.configPath.path
        let backupPath = configPath + ".backup"

        if fileManager.fileExists(atPath: configPath) {
            // Create a backup of the config file
            if let configData = try? Data(contentsOf: URL(fileURLWithPath: configPath)) {
                // Make backup
                try? configData.write(to: URL(fileURLWithPath: backupPath))

                // Remove the original file to clear all locks
                try? fileManager.removeItem(atPath: configPath)
                Logger.info(
                    "Removed original config file to clear locks",
                    metadata: ["name": vmDirContext.name])

                // Wait a moment for OS to fully release resources
                Thread.sleep(forTimeInterval: 0.1)

                // Restore from backup
                try? configData.write(to: URL(fileURLWithPath: configPath))
                Logger.info(
                    "Restored config file from backup", metadata: ["name": vmDirContext.name])
            } else {
                Logger.error(
                    "Could not read config file content for backup",
                    metadata: ["name": vmDirContext.name])
            }
        } else {
            Logger.info(
                "Config file does not exist, cannot perform aggressive unlock",
                metadata: ["name": vmDirContext.name])
        }

        // Final check
        if let finalHandle = try? FileHandle(forWritingTo: vmDirContext.dir.configPath.url) {
            let lockResult = flock(finalHandle.fileDescriptor, LOCK_EX | LOCK_NB)
            if lockResult == 0 {
                Logger.info(
                    "Lock successfully cleared - verified by acquiring test lock",
                    metadata: ["name": vmDirContext.name])
                flock(finalHandle.fileDescriptor, LOCK_UN)
            } else {
                Logger.info(
                    "Lock still present after all clearing attempts",
                    metadata: ["name": vmDirContext.name, "severity": "warning"])
            }
            try? finalHandle.close()
        }
    }

    // MARK: - Resource Management

    func updateVMConfig(vmConfig: VMConfig) throws {
        vmDirContext.config = vmConfig
        try vmDirContext.saveConfig()
    }

    private func getDiskSize() throws -> DiskSize {
        let resourceValues = try vmDirContext.diskPath.url.resourceValues(forKeys: [
            .totalFileAllocatedSizeKey,
            .totalFileSizeKey,
        ])

        guard let allocated = resourceValues.totalFileAllocatedSize,
            let total = resourceValues.totalFileSize
        else {
            throw VMConfigError.invalidDiskSize
        }

        return DiskSize(allocated: UInt64(allocated), total: UInt64(total))
    }

    func resizeDisk(_ newSize: UInt64) throws {
        let currentSize = try getDiskSize()

        guard newSize >= currentSize.total else {
            throw VMError.resizeTooSmall(current: currentSize.total, requested: newSize)
        }

        try setDiskSize(newSize)
    }

    func setCpuCount(_ newCpuCount: Int) throws {
        guard !isRunning else {
            throw VMError.alreadyRunning(vmDirContext.name)
        }
        vmDirContext.config.setCpuCount(newCpuCount)
        try vmDirContext.saveConfig()
    }

    func setMemorySize(_ newMemorySize: UInt64) throws {
        guard !isRunning else {
            throw VMError.alreadyRunning(vmDirContext.name)
        }
        vmDirContext.config.setMemorySize(newMemorySize)
        try vmDirContext.saveConfig()
    }

    func setDiskSize(_ newDiskSize: UInt64) throws {
        try vmDirContext.setDisk(newDiskSize)
        vmDirContext.config.setDiskSize(newDiskSize)
        try vmDirContext.saveConfig()
    }

    func setDisplay(_ newDisplay: String) throws {
        guard !isRunning else {
            throw VMError.alreadyRunning(vmDirContext.name)
        }
        guard let display: VMDisplayResolution = VMDisplayResolution(string: newDisplay) else {
            throw VMError.invalidDisplayResolution(newDisplay)
        }
        vmDirContext.config.setDisplay(display)
        try vmDirContext.saveConfig()
    }

    func setHardwareModel(_ newHardwareModel: Data) throws {
        guard !isRunning else {
            throw VMError.alreadyRunning(vmDirContext.name)
        }
        vmDirContext.config.setHardwareModel(newHardwareModel)
        try vmDirContext.saveConfig()
    }

    func setMachineIdentifier(_ newMachineIdentifier: Data) throws {
        guard !isRunning else {
            throw VMError.alreadyRunning(vmDirContext.name)
        }
        vmDirContext.config.setMachineIdentifier(newMachineIdentifier)
        try vmDirContext.saveConfig()
    }

    func setMacAddress(_ newMacAddress: String) throws {
        guard !isRunning else {
            throw VMError.alreadyRunning(vmDirContext.name)
        }
        vmDirContext.config.setMacAddress(newMacAddress)
        try vmDirContext.saveConfig()
    }

    // MARK: - VNC Management

    func getVNCUrl() -> String? {
        return vncService.url
    }

    /// Best-effort write of VNC config into the VM via SSH.
    /// Silently gives up if SSH is not available (e.g., SSH disabled on the VM).
    /// The guest can still read config from VirtioFS or use hardcoded defaults.
    static func writeVNCConfigViaSSH(
        vmName: String, storage: String?, port: Int, password: String
    ) async {
        let envContent = "VNC_PORT=\(port)\nVNC_PASSWORD=\(password)"
        let command = "echo '\(envContent)' > ~/.vnc.env"

        for _ in 1...6 {
            do {
                let details = try await MainActor.run {
                    let controller = LumeController()
                    return try controller.getDetails(name: vmName, storage: storage)
                }
                guard details.status == "running",
                      let ip = details.ipAddress, !ip.isEmpty,
                      details.sshAvailable == true else {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    continue
                }

                let client = SystemSSHClient(host: ip, port: 22, user: "lume", password: "lume")
                let result = try client.execute(command: command, timeout: 10)
                if result.exitCode == 0 {
                    Logger.info("Wrote VNC config to VM via SSH", metadata: [
                        "name": vmName, "port": "\(port)"])
                    return
                }
            } catch {
                // SSH not available — silently retry or give up
            }
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
        // Silent give-up: SSH may be disabled on this VM, which is fine.
        // The guest can still discover VNC config via VirtioFS or defaults.
    }

    /// Sets up the VNC service and returns the VNC URL
    private func startVNCService(port: Int = 0, password: String? = nil) async throws -> String {
        guard let service = virtualizationService else {
            throw VMError.internalError("Virtualization service not initialized")
        }

        try await vncService.start(port: port, password: password, virtualMachine: service.getVirtualMachine())

        guard let url = vncService.url else {
            throw VMError.vncNotConfigured
        }

        return url
    }

    /// Saves the session information including shared directories to disk.
    /// `xpcPid` is the PID of the spawned VirtualMachine.xpc child once
    /// known — captured after `service.start()` returns and re-saved over
    /// the early "starting" session. Optional so the early save (before
    /// the VM has actually been spawned) can persist the URL without
    /// blocking on the child process.
    private func saveSessionData(
        url: String,
        sharedDirectories: [SharedDirectory],
        xpcPid: Int32? = nil
    ) {
        do {
            let session = VNCSession(
                url: url,
                sharedDirectories: sharedDirectories.isEmpty ? nil : sharedDirectories,
                xpcPid: xpcPid
            )
            try vmDirContext.dir.saveSession(session)
            Logger.info(
                "Saved VNC session with shared directories",
                metadata: [
                    "count": "\(sharedDirectories.count)",
                    "dirs": "\(sharedDirectories.map { $0.hostPath }.joined(separator: ", "))",
                    "sessionsPath": "\(vmDirContext.dir.sessionsPath.path)",
                    "xpcPid": xpcPid.map { "\($0)" } ?? "nil",
                ])
        } catch {
            Logger.error("Failed to save VNC session", metadata: ["error": "\(error)"])
        }
    }

    /// Main session setup method that handles VNC and persists session data
    private func setupSession(
        port: Int = 0, password: String? = nil, sharedDirectories: [SharedDirectory] = []
    ) async throws -> String {
        // Start the VNC service and get the URL
        let url = try await startVNCService(port: port, password: password)

        // Save the session data
        saveSessionData(url: url, sharedDirectories: sharedDirectories)

        return url
    }

    /// Avoid opening Screen Sharing on an all-black initial framebuffer.
    /// This only runs for the real VNC service (not mocks in tests).
    private func waitForVisibleFramebufferBeforeOpeningClient() async {
        guard vncService is DefaultVNCService else {
            return
        }

        do {
            try await vncService.connectInputClient()
            defer { vncService.disconnectInputClient() }

            let timeoutSeconds = 30
            for _ in 0..<timeoutSeconds {
                if let image = try? await vncService.captureFramebuffer(),
                    framebufferHasVisiblePixels(image)
                {
                    Logger.info(
                        "Detected visible VM framebuffer content before opening VNC client",
                        metadata: ["name": vmDirContext.name]
                    )
                    return
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }

            Logger.info(
                "Timed out waiting for visible framebuffer content; opening VNC client anyway",
                metadata: ["name": vmDirContext.name, "timeout_seconds": "\(timeoutSeconds)"]
            )
        } catch {
            Logger.info(
                "Framebuffer readiness check failed; opening VNC client anyway",
                metadata: ["name": vmDirContext.name, "error": "\(error)"]
            )
        }
    }

    /// Fast heuristic: sample bytes from the framebuffer and treat any non-zero value as visible content.
    private func framebufferHasVisiblePixels(_ image: CGImage) -> Bool {
        guard let dataProvider = image.dataProvider,
            let data = dataProvider.data,
            let bytes = CFDataGetBytePtr(data)
        else {
            // If we can't inspect pixels, do not block client opening.
            return true
        }

        let count = CFDataGetLength(data)
        guard count > 0 else {
            return false
        }

        let stride = max(1, count / 4096)
        var index = 0
        while index < count {
            if bytes[index] != 0 {
                return true
            }
            index += stride
        }

        return false
    }

    // MARK: - Platform-specific Methods

    func getOSType() -> String {
        fatalError("Must be implemented by subclass")
    }

    func createVMVirtualizationServiceContext(
        cpuCount: Int,
        memorySize: UInt64,
        display: String,
        sharedDirectories: [SharedDirectory] = [],
        mount: Path? = nil,
        recoveryMode: Bool = false,
        usbMassStoragePaths: [Path]? = nil,
        networkMode: NetworkMode? = nil,
        headless: Bool = false
    ) throws -> VMVirtualizationServiceContext {
        // This is a diagnostic log to track actual file paths on disk for debugging
        try validateDiskState()

        // Use provided networkMode, falling back to config value
        let effectiveNetworkMode = networkMode ?? vmDirContext.config.networkMode

        // wells: B.0.9.d.4.e — Linux VM machineIdentifier persistence.
        // VZGenericPlatformConfiguration() generates a fresh
        // VZGenericMachineIdentifier each time. saveStateTo persists it
        // in the saved state file; restoreStateFrom rejects with
        // "invalid argument" if the new config's identifier differs.
        // Pre-generate on first run, persist to config.json, reuse on
        // subsequent runs. macOS-side has its own machineIdentifier
        // path (DarwinVirtualizationService); Linux didn't until now.
        var resolvedMachineIdentifier = vmDirContext.config.machineIdentifier
        if resolvedMachineIdentifier == nil,
           vmDirContext.config.os.lowercased() == "linux",
           #available(macOS 13, *) {
            let id = VZGenericMachineIdentifier()
            let data = id.dataRepresentation
            resolvedMachineIdentifier = data
            // Persist to bundle's config.json so it survives lume restart.
            var updated = vmDirContext.config
            updated.machineIdentifier = data
            try vmDirContext.dir.saveConfig(updated)
            Logger.info(
                "Generated and persisted Linux VM machineIdentifier",
                metadata: ["name": vmDirContext.name, "size": "\(data.count)"])
        }

        return VMVirtualizationServiceContext(
            cpuCount: cpuCount,
            memorySize: memorySize,
            display: display,
            sharedDirectories: sharedDirectories,
            mount: mount,
            hardwareModel: vmDirContext.config.hardwareModel,
            machineIdentifier: resolvedMachineIdentifier,
            macAddress: vmDirContext.config.macAddress!,
            diskPath: vmDirContext.diskPath,
            nvramPath: vmDirContext.nvramPath,
            recoveryMode: recoveryMode,
            usbMassStoragePaths: usbMassStoragePaths,
            networkMode: effectiveNetworkMode,
            headless: headless
        )
    }

    /// Validates the disk state to help diagnose storage attachment issues
    private func validateDiskState() throws {
        // Check disk image state
        let diskPath = vmDirContext.diskPath.path
        let diskExists = FileManager.default.fileExists(atPath: diskPath)
        var diskSize: UInt64 = 0
        var diskPermissions = ""

        if diskExists {
            if let attrs = try? FileManager.default.attributesOfItem(atPath: diskPath) {
                diskSize = attrs[.size] as? UInt64 ?? 0
                let posixPerms = attrs[.posixPermissions] as? Int ?? 0
                diskPermissions = String(format: "%o", posixPerms)
            }
        }

        // Check disk container directory permissions
        let diskDir = (diskPath as NSString).deletingLastPathComponent
        let dirPerms =
            try? FileManager.default.attributesOfItem(atPath: diskDir)[.posixPermissions] as? Int
            ?? 0
        let dirPermsString = dirPerms != nil ? String(format: "%o", dirPerms!) : "unknown"

        // Log detailed diagnostics
        Logger.info(
            "Validating VM disk state",
            metadata: [
                "diskPath": diskPath,
                "diskExists": "\(diskExists)",
                "diskSize":
                    "\(ByteCountFormatter.string(fromByteCount: Int64(diskSize), countStyle: .file))",
                "diskPermissions": diskPermissions,
                "dirPermissions": dirPermsString,
                "locationName": vmDirContext.storage ?? "home",
            ])

        if !diskExists {
            Logger.error("VM disk image does not exist", metadata: ["diskPath": diskPath])
        } else if diskSize == 0 {
            Logger.error("VM disk image exists but has zero size", metadata: ["diskPath": diskPath])
        }
    }

    func setup(
        ipswPath: String,
        cpuCount: Int,
        memorySize: UInt64,
        diskSize: UInt64,
        display: String
    ) async throws {
        fatalError("Must be implemented by subclass")
    }

    // MARK: - Finalization

    /// Post-installation step to move the VM directory to the home directory
    func finalize(to name: String, home: Home, storage: String? = nil) throws {
        let vmDir = try home.getVMDirectory(name, storage: storage)
        try FileManager.default.moveItem(at: vmDirContext.dir.dir.url, to: vmDir.dir.url)
    }

    // Method to run VM with additional USB mass storage devices
    func runWithUSBStorage(
        noDisplay: Bool, sharedDirectories: [SharedDirectory], mount: Path?, vncPort: Int = 0,
        recoveryMode: Bool = false, usbImagePaths: [Path]
    ) async throws {
        guard vmDirContext.initialized else {
            throw VMError.notInitialized(vmDirContext.name)
        }

        guard let cpuCount = vmDirContext.config.cpuCount,
            let memorySize = vmDirContext.config.memorySize
        else {
            throw VMError.notInitialized(vmDirContext.name)
        }

        // Try to acquire lock on config file
        let fileHandle = try FileHandle(forWritingTo: vmDirContext.dir.configPath.url)
        guard flock(fileHandle.fileDescriptor, LOCK_EX | LOCK_NB) == 0 else {
            try? fileHandle.close()
            throw VMError.alreadyRunning(vmDirContext.name)
        }

        Logger.info(
            "Running VM with USB storage devices",
            metadata: [
                "cpuCount": "\(cpuCount)",
                "memorySize": "\(memorySize)",
                "diskSize": "\(vmDirContext.config.diskSize ?? 0)",
                "usbImageCount": "\(usbImagePaths.count)",
                "recoveryMode": "\(recoveryMode)",
            ])

        // Create and configure the VM
        do {
            // Create lume-config shared directory for VNC discovery
            let lumeConfigDir = FileManager.default.temporaryDirectory
                .appendingPathComponent("lume-config-\(vmDirContext.name)")
            try? FileManager.default.createDirectory(at: lumeConfigDir, withIntermediateDirectories: true)
            try? FileManager.default.removeItem(
                at: lumeConfigDir.appendingPathComponent("vnc.env"))
            let lumeConfigSharedDir = SharedDirectory(
                hostPath: lumeConfigDir.path, tag: "lume-config", readOnly: true)
            var allSharedDirectories = sharedDirectories
            allSharedDirectories.append(lumeConfigSharedDir)

            let config = try createVMVirtualizationServiceContext(
                cpuCount: cpuCount,
                memorySize: memorySize,
                display: vmDirContext.config.display.string,
                sharedDirectories: allSharedDirectories,
                mount: mount,
                recoveryMode: recoveryMode,
                usbMassStoragePaths: usbImagePaths,
                headless: noDisplay
            )
            virtualizationService = try virtualizationServiceFactory(config)

            let vncInfo = try await setupSession(
                port: vncPort, sharedDirectories: sharedDirectories)
            Logger.info("VNC info", metadata: ["vncInfo": vncInfo])

            // Write VNC config to shared directory for guest discovery
            var vncPortValue: Int?
            var vncPasswordValue: String?
            if let components = URLComponents(string: vncInfo.replacingOccurrences(of: "vnc://", with: "http://")),
               let port = components.port {
                vncPortValue = port
                vncPasswordValue = components.password ?? ""
                let envContent = "VNC_PORT=\(port)\nVNC_PASSWORD=\(vncPasswordValue!)\n"
                try? envContent.write(
                    to: lumeConfigDir.appendingPathComponent("vnc.env"),
                    atomically: true, encoding: .utf8)
            }

            // Start the VM
            guard let service = virtualizationService else {
                throw VMError.internalError("Virtualization service not initialized")
            }
            try await service.start()

            if !noDisplay {
                await waitForVisibleFramebufferBeforeOpeningClient()
                Logger.info("Starting VNC session", metadata: ["name": vmDirContext.name])
                try await vncService.openClient(url: vncInfo)
            }

            // Write VNC config into VM via SSH (background task)
            if let port = vncPortValue, let password = vncPasswordValue {
                let vmName = vmDirContext.name
                let storage = vmDirContext.storage
                Task.detached {
                    await VM.writeVNCConfigViaSSH(
                        vmName: vmName, storage: storage, port: port, password: password)
                }
            }

            while true {
                try await Task.sleep(nanoseconds: UInt64(1e9))
            }
        } catch {
            Logger.error(
                "Failed to create/start VM with USB storage",
                metadata: [
                    "error": "\(error)",
                    "errorType": "\(type(of: error))",
                ])
            virtualizationService = nil
            vncService.stop()
            // Release lock
            flock(fileHandle.fileDescriptor, LOCK_UN)
            try? fileHandle.close()
            throw error
        }
    }
}
