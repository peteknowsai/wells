// Wells menu bar — a tiny NSStatusItem utility that shows the wells
// substrate at a glance and offers a one-click welld restart.
//
// It polls http://127.0.0.1:7878/dashboard/data every 6s — the same JSON
// the operator dashboard renders from. The drop icon is green when welld
// is healthy and every well is accounted for, amber when welld reports
// degraded or a well is missing, red (hollow) when :7878 is unreachable.
//
// The dropdown shows: welld version + uptime; the fleet (well counts + a
// submenu of every well with its status and IP); Mac memory (read locally
// via mach — welld doesn't report the host total); the base image; lume
// respawns + orphan leases. Plus Restart welld / Open Dashboard / Open Logs.
//
// Built by scripts/build-menubar.sh into bin/WellsMenuBar.app. This app
// only reads welld and can kickstart its LaunchAgent — it never touches
// well state directly.

import Cocoa
import Darwin

// MARK: - Model

struct Well {
    let name: String
    let status: String  // raw lume status: "running" | "stopped" | "missing"
    // What we actually show. lume can't tell a hibernated VM from a cold
    // one — both report "stopped" — so a hibernating well looks identical
    // to a dead one in the raw status. We refine it from welld's own
    // runtime.json (the lifecycle source of truth): a "stopped" lume
    // status + runtime state "hibernating" is displayed as "hibernating".
    let displayStatus: String  // "running" | "hibernating" | "stopped" | "missing"
    let ip: String?
    let residentBytes: Double?  // physical RAM the well holds on the Mac
}

struct BaseImage {
    let name: String
    let sizeBytes: Double?
    let createdAt: Date?
}

struct Substrate {
    let version: String
    let uptimeSeconds: Int
    let degraded: Bool
    let respawnsHour: Int
    let wells: [Well]
    let orphanLeases: Int
    let baseImage: BaseImage?
    let imageCount: Int

    var running: Int { wells.filter { $0.displayStatus == "running" }.count }
    var hibernating: Int { wells.filter { $0.displayStatus == "hibernating" }.count }
    var stopped: Int { wells.filter { $0.displayStatus == "stopped" }.count }
    var missing: Int { wells.filter { $0.displayStatus == "missing" }.count }
    var healthy: Bool { !degraded && missing == 0 }
    // Total physical RAM the wells are holding on the Mac right now.
    var heldBytes: Double { wells.compactMap { $0.residentBytes }.reduce(0, +) }
}

struct HostMemory {
    let usedBytes: UInt64
    let totalBytes: UInt64
}

enum WelldState {
    case up(Substrate)
    case down
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var state: WelldState = .down
    private var memory: HostMemory?

    private let dataURL = URL(string: "http://127.0.0.1:7878/dashboard/data")!
    private let dashboardURL = URL(string: "http://127.0.0.1:7878/dashboard")!
    private let logPath = (NSHomeDirectory() as NSString).appendingPathComponent(".wells/welld.log")
    private let welldLabel = "md.cells.welld"
    private let pollInterval: TimeInterval = 6

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu

        memory = AppDelegate.readHostMemory()
        renderIcon()
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.poll()
        }
    }

    // MARK: polling

    private func poll() {
        // Host memory is a local, instant read — refresh it every tick.
        let mem = AppDelegate.readHostMemory()

        var req = URLRequest(url: dataURL)
        req.timeoutInterval = 4
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            let newState: WelldState
            if let data = data,
               (resp as? HTTPURLResponse)?.statusCode == 200,
               let s = AppDelegate.parseSubstrate(data) {
                newState = .up(s)
            } else {
                newState = .down
            }
            DispatchQueue.main.async {
                self?.memory = mem
                self?.state = newState
                self?.renderIcon()
            }
        }.resume()
    }

    private static func parseSubstrate(_ data: Data) -> Substrate? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let daemon = obj["daemon"] as? [String: Any] else {
            return nil
        }
        let version = daemon["version"] as? String ?? "?"
        let uptime = daemon["uptime_seconds"] as? Int ?? 0
        let degraded = daemon["degraded"] as? Bool ?? false
        let respawnsHour = (daemon["lume"] as? [String: Any])?["respawns_last_hour"] as? Int ?? 0

        var wells: [Well] = []
        if let arr = obj["wells"] as? [[String: Any]] {
            for w in arr {
                guard let name = w["name"] as? String else { continue }
                let raw = w["status"] as? String ?? "missing"
                // Refine "stopped" → "hibernating" from runtime.json.
                var display = raw
                if raw == "stopped",
                   AppDelegate.runtimeState(forWell: name) == "hibernating" {
                    display = "hibernating"
                }
                wells.append(Well(name: name,
                                  status: raw,
                                  displayStatus: display,
                                  ip: w["ip"] as? String,
                                  residentBytes: (w["resident_bytes"] as? Int).map(Double.init)))
            }
        }

        let orphanLeases = (obj["vmnet_leases"] as? [String: Any])?["orphan_count"] as? Int ?? 0

        var baseImage: BaseImage?
        var imageCount = 0
        if let imgs = obj["images"] as? [[String: Any]] {
            imageCount = imgs.count
            // The base image is the prebuilt one — no originating well.
            let prebuilt = imgs.filter { !($0["from_well"] is String) }
            let pick = prebuilt.first { ($0["name"] as? String)?.contains("base") == true }
                ?? prebuilt.first ?? imgs.first
            if let pick = pick, let name = pick["name"] as? String {
                baseImage = BaseImage(
                    name: name,
                    sizeBytes: (pick["size_bytes"] as? Int).map(Double.init),
                    createdAt: AppDelegate.parseDate(pick["created_at"] as? String))
            }
        }

        return Substrate(version: version, uptimeSeconds: uptime, degraded: degraded,
                         respawnsHour: respawnsHour, wells: wells, orphanLeases: orphanLeases,
                         baseImage: baseImage, imageCount: imageCount)
    }

    // welld's per-well lifecycle truth. Read locally — the menu bar
    // already reads ~/.wells/welld.log directly, and the dashboard API's
    // sprite-shaped `status` collapses hibernating into stopped. nil when
    // the file is absent or unparseable (treated as "not hibernating").
    private static func runtimeState(forWell name: String) -> String? {
        let path = (NSHomeDirectory() as NSString)
            .appendingPathComponent(".wells/vms/\(name)/runtime.json")
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return obj["state"] as? String
    }

    // MARK: icon

    private func renderIcon() {
        guard let button = statusItem.button else { return }
        let symbol: String
        let color: NSColor
        switch state {
        case .down:
            symbol = "drop"; color = .systemRed
        case .up(let s):
            symbol = "drop.fill"
            color = s.healthy ? .systemGreen : .systemOrange
        }
        // Non-template image with the colour baked in via a palette config.
        // A template image would be re-coloured to match the menu bar (black
        // / white) and lose the green/amber/red signal that is the whole point.
        let config = NSImage.SymbolConfiguration(paletteColors: [color])
        if let base = NSImage(systemSymbolName: symbol, accessibilityDescription: "welld status"),
           let img = base.withSymbolConfiguration(config) {
            img.isTemplate = false
            button.image = img
            button.contentTintColor = nil
            button.title = ""
        } else {
            button.image = nil
            button.attributedTitle = NSAttributedString(
                string: "\u{25CF}", attributes: [.foregroundColor: color])
        }
    }

    // MARK: menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        switch state {
        case .up(let s):
            let dot: NSColor = s.healthy ? .systemGreen : .systemOrange
            addHeader(menu, dot: dot, text: "welld \u{00B7} \(s.degraded ? "degraded" : "healthy")")
            addInfo(menu, "v\(s.version) \u{00B7} up \(AppDelegate.formatUptime(s.uptimeSeconds))")

            menu.addItem(.separator())
            addFleet(menu, s)

            menu.addItem(.separator())
            addSubstrate(menu, s)

        case .down:
            addHeader(menu, dot: .systemRed, text: "welld \u{00B7} not responding")
            addInfo(menu, ":7878 unreachable")
            if let m = memory {
                menu.addItem(.separator())
                addInfo(menu, "Mac memory \u{00B7} " + AppDelegate.memorySummary(m))
            }
        }

        menu.addItem(.separator())
        addAction(menu, "Restart welld", #selector(restartWelld), key: "r")
        if case .up = state {
            addAction(menu, "Open Dashboard", #selector(openDashboard), key: "d")
        }
        addAction(menu, "Open Logs", #selector(openLogs), key: "l")
        menu.addItem(.separator())
        addAction(menu, "Quit Wells Menu Bar", #selector(quit), key: "q")
    }

    private func addFleet(_ menu: NSMenu, _ s: Substrate) {
        guard !s.wells.isEmpty else {
            addInfo(menu, "no wells registered")
            return
        }
        var summary = "\(s.wells.count) well\(s.wells.count == 1 ? "" : "s") \u{00B7} \(s.running) running"
        if s.hibernating > 0 { summary += " \u{00B7} \(s.hibernating) hibernating" }
        if s.stopped > 0 { summary += " \u{00B7} \(s.stopped) stopped" }
        if s.missing > 0 { summary += " \u{00B7} \(s.missing) missing" }
        addInfo(menu, summary)
        if s.heldBytes > 0 {
            addInfo(menu, "holding ~\(AppDelegate.formatBytes(s.heldBytes)) on the Mac")
        }

        // Wells submenu — every well with a coloured status dot. Running
        // wells (those with an IP) copy their IP to the clipboard on click.
        // Sorted running-first (then alphabetical) so the live wells are
        // at the top — they're what the operator usually wants, and a long
        // tail of cold pool eggs shouldn't bury them.
        let wellsItem = NSMenuItem(title: "Wells", action: nil, keyEquivalent: "")
        wellsItem.isEnabled = true
        let sub = NSMenu()
        sub.autoenablesItems = false
        let statusRank: (String) -> Int = { status in
            switch status {
            case "running":     return 0
            case "missing":     return 1  // an error state — keep it visible
            case "hibernating": return 2
            default:            return 3  // stopped
            }
        }
        let sortedWells = s.wells.sorted { a, b in
            let ra = statusRank(a.displayStatus), rb = statusRank(b.displayStatus)
            return ra != rb ? ra < rb : a.name < b.name
        }
        for w in sortedWells {
            let dot: NSColor
            switch w.displayStatus {
            case "running":     dot = .systemGreen
            case "missing":     dot = .systemRed
            case "hibernating": dot = .systemBlue
            default:            dot = .tertiaryLabelColor
            }
            var label = "\(w.name) \u{00B7} \(w.displayStatus)"
            if let ip = w.ip { label += " \u{00B7} \(ip)" }
            if let rb = w.residentBytes, rb > 0 {
                label += " \u{00B7} \(AppDelegate.formatBytes(rb))"
            }
            let item = NSMenuItem(
                title: label,
                action: w.ip != nil ? #selector(copyWellIp(_:)) : nil,
                keyEquivalent: "")
            item.target = self
            item.isEnabled = w.ip != nil
            item.representedObject = w.ip
            let attr = NSMutableAttributedString()
            attr.append(NSAttributedString(string: "\u{25CF}  ", attributes: [.foregroundColor: dot]))
            attr.append(NSAttributedString(string: label, attributes: [.font: NSFont.menuFont(ofSize: 0)]))
            item.attributedTitle = attr
            sub.addItem(item)
        }
        wellsItem.submenu = sub
        menu.addItem(wellsItem)
    }

    private func addSubstrate(_ menu: NSMenu, _ s: Substrate) {
        if let m = memory {
            addInfo(menu, "Mac memory \u{00B7} " + AppDelegate.memorySummary(m))
        }
        if let img = s.baseImage {
            var line = img.name
            if let sz = img.sizeBytes { line += " \u{00B7} " + AppDelegate.formatBytes(sz) }
            if let created = img.createdAt { line += " \u{00B7} " + AppDelegate.formatAge(created) }
            if s.imageCount > 1 { line += " (+\(s.imageCount - 1) more)" }
            addInfo(menu, line)
        }
        var line = "\(s.respawnsHour) respawn\(s.respawnsHour == 1 ? "" : "s")/hr"
        if s.orphanLeases > 0 { line += " \u{00B7} \(s.orphanLeases) orphan leases" }
        addInfo(menu, line)
    }

    private func addHeader(_ menu: NSMenu, dot: NSColor, text: String) {
        let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        item.isEnabled = true
        let attr = NSMutableAttributedString()
        attr.append(NSAttributedString(string: "\u{25CF} ", attributes: [.foregroundColor: dot]))
        attr.append(NSAttributedString(string: text, attributes: [
            .font: NSFont.boldSystemFont(ofSize: NSFont.systemFontSize),
        ]))
        item.attributedTitle = attr
        menu.addItem(item)
    }

    private func addInfo(_ menu: NSMenu, _ text: String) {
        let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        item.isEnabled = false
        item.attributedTitle = NSAttributedString(string: "    " + text, attributes: [
            .font: NSFont.menuFont(ofSize: NSFont.smallSystemFontSize),
            .foregroundColor: NSColor.secondaryLabelColor,
        ])
        menu.addItem(item)
    }

    private func addAction(_ menu: NSMenu, _ title: String, _ sel: Selector, key: String) {
        let item = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        item.target = self
        item.isEnabled = true
        menu.addItem(item)
    }

    // MARK: formatting

    private static func formatUptime(_ secs: Int) -> String {
        if secs < 0 { return "just now" }
        let d = secs / 86400, h = (secs % 86400) / 3600
        let m = (secs % 3600) / 60, s = secs % 60
        if d > 0 { return "\(d)d \(h)h" }
        if h > 0 { return "\(h)h \(m)m" }
        if m > 0 { return "\(m)m" }
        return "\(s)s"
    }

    private static func formatAge(_ date: Date) -> String {
        let s = Int(Date().timeIntervalSince(date))
        if s < 0 { return "just now" }
        if s < 3600 { return "\(max(1, s / 60))m" }
        if s < 86400 { return "\(s / 3600)h" }
        return "\(s / 86400)d"
    }

    private static func formatBytes(_ n: Double) -> String {
        guard n > 0 else { return "0 B" }
        let units = ["B", "KB", "MB", "GB", "TB"]
        var v = n, i = 0
        while v >= 1024 && i < units.count - 1 { v /= 1024; i += 1 }
        return (v >= 10 ? String(format: "%.0f", v) : String(format: "%.1f", v)) + " " + units[i]
    }

    private static func memorySummary(_ m: HostMemory) -> String {
        let free = m.totalBytes > m.usedBytes ? m.totalBytes - m.usedBytes : 0
        return "\(formatBytes(Double(m.usedBytes))) used \u{00B7} \(formatBytes(Double(free))) free"
    }

    private static func parseDate(_ s: String?) -> Date? {
        guard let s = s else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: s) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: s)
    }

    // Host memory via mach — welld can't report the host total, but this
    // app runs on the host, so it just reads it. "Used" mirrors Activity
    // Monitor: active + wired + compressed pages.
    private static func readHostMemory() -> HostMemory? {
        let total = ProcessInfo.processInfo.physicalMemory
        var stats = vm_statistics64_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<vm_statistics64_data_t>.stride / MemoryLayout<integer_t>.stride)
        let kr = withUnsafeMutablePointer(to: &stats) { ptr -> kern_return_t in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return nil }
        let pageSize = UInt64(vm_page_size)
        let used = (UInt64(stats.active_count) + UInt64(stats.wire_count)
            + UInt64(stats.compressor_page_count)) * pageSize
        return HostMemory(usedBytes: min(used, total), totalBytes: total)
    }

    // MARK: actions

    @objc private func copyWellIp(_ sender: NSMenuItem) {
        guard let ip = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(ip, forType: .string)
    }

    @objc private func restartWelld() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["kickstart", "-k", "gui/\(getuid())/\(welldLabel)"]
        do {
            try task.run()
        } catch {
            NSLog("wells-menubar: failed to kickstart \(welldLabel): \(error)")
        }
        // Reflect the bounce: poll again shortly after the restart settles.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.poll() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in self?.poll() }
    }

    @objc private func openDashboard() {
        NSWorkspace.shared.open(dashboardURL)
    }

    @objc private func openLogs() {
        NSWorkspace.shared.open(URL(fileURLWithPath: logPath))
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

// MARK: - Entry point
//
// Compiled as a single file, so this runs as top-level code (no @main).
// `delegate` becomes a module global — retained for the process lifetime,
// which matters because NSApplication.delegate is a weak reference.

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
