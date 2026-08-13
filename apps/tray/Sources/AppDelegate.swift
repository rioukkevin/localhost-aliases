import AppKit
import Darwin

/// Wiring only. Every behaviour lives in its own file; this class owns the objects,
/// the state and the menu actions.
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, MenuActions {
    private let layout = RuntimeLayout.resolve()
    private let log = Logger(path: Paths.trayLogPath)

    private var statusItem: NSStatusItem!
    private var dashboard: DashboardProcess!
    private var heartbeat: Heartbeat!
    private var poller: StatusPoller!
    private var signalSources: [DispatchSourceSignal] = []

    private var state = TrayState()
    private var isTerminating = false
    private var hasOfferedLaunchApply = false

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        log.log("tray: launch mode=\(layout.mode.rawValue) root=\(layout.root)")
        state.config = AppConfig.load()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = StatusIcon.image(state.iconKind)
        statusItem.button?.toolTip = Paths.appName
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        heartbeat = Heartbeat(log: log)
        heartbeat.start()

        dashboard = DashboardProcess(layout: layout, log: log) { [weak self] newState in
            guard let self else { return }
            self.state.dashboard = newState
            self.refreshIcon()
        }
        dashboard.start(port: state.config.dashboardPort)

        poller = StatusPoller(log: log) { [weak self] config, snapshot, statuses in
            guard let self else { return }
            self.state.config = config
            self.state.system = snapshot
            self.state.aliasUp = statuses
            self.refreshIcon()
            self.offerLaunchApplyIfDrifted()
        }
        poller.start()

        installSignalHandlers()
    }

    /// SIGTERM/SIGINT must shut down as cleanly as Quit does — otherwise the liveness file
    /// stays fresh and the root forwarder keeps running with no app to stop it.
    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in
                self?.log.log("tray: received signal \(sig)")
                NSApp.terminate(nil)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !isTerminating else { return .terminateNow }
        isTerminating = true
        log.log("tray: shutting down")
        poller.stop()
        heartbeat.stop()  // removes the liveness file -> the root forwarder exits on its own
        dashboard.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    // MARK: - Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        MenuBuilder.populate(menu, state: state, target: self)
        poller.refreshSoon()
    }

    private func refreshIcon() {
        statusItem?.button?.image = StatusIcon.image(state.iconKind)
        statusItem?.button?.toolTip = "\(Paths.appName) — \(state.statusLine)"
    }

    // MARK: - Actions

    func openDashboard(_ sender: Any?) {
        open(urlString: state.dashboardURL)
    }

    func openAlias(_ sender: Any?) {
        guard let item = sender as? NSMenuItem, let urlString = item.representedObject as? String
        else { return }
        open(urlString: urlString)
    }

    func restartDashboard(_ sender: Any?) {
        dashboard.restart(port: state.config.dashboardPort)
    }

    /// Privileged action #1 of 2. See PrivilegedApply.swift.
    func reapplyAliases(_ sender: Any?) {
        let confirmed = confirm(
            title: "Re-apply aliases?",
            body: "macOS will ask for your administrator password once. "
                + "This updates the managed block in /etc/hosts, the loopback addresses on lo0, "
                + "flushes DNS and restarts the forwarder. Nothing is installed permanently.",
            action: "Re-apply")
        guard confirmed else { return }
        runPrivileged(.apply)
    }

    /// Privileged action #2 of 2. See PrivilegedApply.swift.
    func uninstallEverything(_ sender: Any?) {
        let confirmed = confirm(
            title: "Remove every change this app made?",
            body: "The forwarder stops, the lo0 addresses and the /etc/hosts block are removed, "
                + "DNS is flushed and your aliases are deleted. "
                + "macOS will ask for your administrator password once.",
            action: "Uninstall",
            destructive: true)
        guard confirmed else { return }
        runPrivileged(.uninstall)
    }

    func quitApp(_ sender: Any?) {
        NSApp.terminate(nil)
    }

    /// docs/V2.md wants one prompt at launch when the live state has drifted (a reboot clears
    /// the lo0 aliases). That would put a dialog on screen with nobody asking for it, so it is
    /// opt-in: without LA_PROMPT_ON_LAUNCH_DRIFT the tray only turns the icon to "attention"
    /// and waits for the user to pick Re-apply Aliases. Onboarding drives the first apply.
    private func offerLaunchApplyIfDrifted() {
        guard Paths.env("LA_PROMPT_ON_LAUNCH_DRIFT") != nil else { return }
        guard !hasOfferedLaunchApply, !state.privilegedBusy else { return }
        guard state.system.dashboardReachable, state.system.needsPrompt else { return }
        hasOfferedLaunchApply = true
        reapplyAliases(nil)
    }

    // MARK: - Helpers

    private func runPrivileged(_ kind: PrivilegedApply.Kind) {
        state.privilegedBusy = true
        state.lastMessage = kind == .apply ? "Applying…" : "Uninstalling…"
        PrivilegedApply.run(layout: layout, kind: kind, log: log) { [weak self] result in
            guard let self else { return }
            self.state.privilegedBusy = false
            if result.ok {
                self.state.lastMessage = nil
                self.poller.refreshSoon()
                if kind == .uninstall { NSApp.terminate(nil) }
            } else if result.cancelled {
                self.state.lastMessage = "Cancelled — nothing changed"
            } else {
                self.state.lastMessage = "Failed — see \(Paths.trayLogPath)"
            }
            self.refreshIcon()
        }
    }

    private func open(urlString: String) {
        guard let url = URL(string: urlString) else { return }
        log.log("tray: opening \(urlString)")
        NSWorkspace.shared.open(url)
    }

    private func confirm(title: String, body: String, action: String, destructive: Bool = false)
        -> Bool
    {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = body
        alert.alertStyle = destructive ? .warning : .informational
        let confirmButton = alert.addButton(withTitle: action)
        alert.addButton(withTitle: "Cancel")
        if destructive { confirmButton.hasDestructiveAction = true }
        return alert.runModal() == .alertFirstButtonReturn
    }
}
