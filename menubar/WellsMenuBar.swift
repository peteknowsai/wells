// Wells menu bar — a tiny NSStatusItem utility that shows the wells
// substrate at a glance and offers a one-click welld restart.
//
// It polls http://127.0.0.1:7878/dashboard/data every 6s. The drop icon is
// white when welld is responding, red (hollow) when :7878 is unreachable.
// The dropdown header dot stays green/amber to distinguish healthy from
// degraded once the menu is open.
//
// The dropdown shows: welld status; the fleet (well counts + a submenu
// of every well with its status and IP); Mac memory (read locally via
// mach — welld doesn't report the host total); respawns/orphan leases
// only when non-zero. Plus Restart welld / Open Dashboard / Open Logs.
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
    // The cells-assigned agent name birthed onto this well, if any.
    // A bare pool egg with no cell yet is nil. Sourced from cells's
    // registry — see AppDelegate.cellNamesByWell().
    let cellName: String?
}

struct Substrate {
    let degraded: Bool
    let respawnsHour: Int
    let wells: [Well]
    let orphanLeases: Int

    var running: Int { wells.filter { $0.displayStatus == "running" }.count }
    var hibernating: Int { wells.filter { $0.displayStatus == "hibernating" }.count }
    var stopped: Int { wells.filter { $0.displayStatus == "stopped" }.count }
    var missing: Int { wells.filter { $0.displayStatus == "missing" }.count }
    var healthy: Bool { !degraded && missing == 0 }
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
        let degraded = daemon["degraded"] as? Bool ?? false
        let respawnsHour = (daemon["lume"] as? [String: Any])?["respawns_last_hour"] as? Int ?? 0

        var wells: [Well] = []
        if let arr = obj["wells"] as? [[String: Any]] {
            let cellNames = AppDelegate.cellNamesByWell()
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
                                  residentBytes: (w["resident_bytes"] as? Int).map(Double.init),
                                  cellName: cellNames[name]))
            }
        }

        let orphanLeases = (obj["vmnet_leases"] as? [String: Any])?["orphan_count"] as? Int ?? 0

        return Substrate(degraded: degraded, respawnsHour: respawnsHour,
                         wells: wells, orphanLeases: orphanLeases)
    }

    // The well → cell-name map, from cells's registry (~/.cells/cells.json).
    // A cell's `hatched_from` is the egg id; the well is "egg-<that>".
    // Best-effort and read-only: if cells.json is absent or its shape
    // drifts, wells just shows bare egg-XXXX names — no hard dependency.
    // Specials (mother/pulse) have no hatched_from; their wells are
    // already named cells-mother / cells-pulse, so they need no mapping.
    private static func cellNamesByWell() -> [String: String] {
        let path = (NSHomeDirectory() as NSString)
            .appendingPathComponent(".cells/cells.json")
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cells = obj["cells"] as? [[String: Any]]
        else { return [:] }
        var map: [String: String] = [:]
        for c in cells {
            guard let name = c["name"] as? String,
                  let egg = c["hatched_from"] as? String,
                  (c["status"] as? String) == "alive"
            else { continue }
            map["egg-\(egg)"] = name
        }
        return map
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
        case .up:
            symbol = "drop.fill"; color = .white
        }
        // Non-template image with the colour baked in via a palette config.
        // A template image would be re-coloured to match the menu bar and
        // lose the red signal we want when welld is down.
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

            menu.addItem(.separator())
            addFleet(menu, s)

            if let m = memory {
                menu.addItem(.separator())
                addInfo(menu, AppDelegate.memorySummary(m))
            }
            // Operational noise — only surface when non-zero.
            var noise: [String] = []
            if s.respawnsHour > 0 {
                noise.append("\(s.respawnsHour) respawn\(s.respawnsHour == 1 ? "" : "s")/hr")
            }
            if s.orphanLeases > 0 { noise.append("\(s.orphanLeases) orphan leases") }
            if !noise.isEmpty { addInfo(menu, noise.joined(separator: " \u{00B7} ")) }

        case .down:
            addHeader(menu, dot: .systemRed, text: "welld \u{00B7} not responding")
            if let m = memory {
                menu.addItem(.separator())
                addInfo(menu, AppDelegate.memorySummary(m))
            }
        }

        menu.addItem(.separator())
        addAction(menu, "Restart welld", #selector(restartWelld), key: "r")
        if case .up = state {
            addAction(menu, "Open Dashboard", #selector(openDashboard), key: "d")
        }
        addAction(menu, "Open Logs", #selector(openLogs), key: "l")
        menu.addItem(.separator())
        addAction(menu, "Quit", #selector(quit), key: "q")
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
            // Show the cell name once one's been birthed onto the well —
            // that's the identity the operator thinks in, and the egg-XXXX
            // id is just noise next to it. Bare pool eggs with no cell
            // fall back to the well name.
            let identity = w.cellName ?? w.name
            var label = "\(identity) \u{00B7} \(w.displayStatus)"
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
        item.attributedTitle = NSAttributedString(string: text, attributes: [
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
