import AppKit

/// Wires the pieces together: the supervised server, the API poll, the two `SMAppService`
/// registrations, and the menu. Holds the only mutable app state, all of it on the main thread.
final class AppDelegate: NSObject, NSApplicationDelegate, StatusMenuDelegate {
    private var statusMenu: StatusMenu?
    private let server = ServerProcess()
    private let poller = HealthPoller()
    private var signalSources: [DispatchSourceSignal] = []

    /// `nil` when this build cannot install the daemon (checkout build, or a bundle without
    /// `Contents/Library/LaunchDaemons/…`). Nothing else in the app can reach `SMAppService`.
    private let helperService = ManagedService.helper()
    private let loginItem = ManagedService.launchAtLogin()

    private var aliases: [Alias] = []
    private var status: SystemStatusSummary?
    private var helperState: ServiceState?
    private var loginState: ServiceState?
    private var isHealthy = false
    /// The dashboard port answered but we did not spawn it: a LaunchAgent or `dev.sh` owns it.
    private var adoptedExternalServer = false
    /// User intent. Survives crash loops, cleared only by "Stop Server".
    private var userWantsServer = true

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusMenu = StatusMenu(delegate: self)
        installSignalHandlers()

        server.onStateChange = { [weak self] in self?.refresh() }
        poller.onResult = { [weak self] result in self?.handle(result) }

        readServiceStates()
        // The first poll decides whether to spawn: never fight an already-running server for
        // the port. `handle(_:)` starts one as soon as the port is found dead.
        poller.start()
        refresh()
    }

    func applicationWillTerminate(_ notification: Notification) {
        poller.stop()
        server.terminateSynchronously()
    }

    /// SIGTERM/SIGINT (launchd, `kill`, Ctrl-C when run from a terminal) must still take the
    /// web server down with us, so route them through the normal quit path.
    private func installSignalHandlers() {
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
        signal(SIGPIPE, SIG_IGN)
    }

    // MARK: - State

    private func handle(_ result: HealthResult) {
        switch result {
        case .healthy(let summary, let list):
            isHealthy = true
            status = summary
            aliases = list.sorted { $0.hostname.localizedStandardCompare($1.hostname) == .orderedAscending }
            if !server.isActive { adoptedExternalServer = true }
        case .unhealthy:
            isHealthy = false
            status = nil
            aliases = []
            adoptedExternalServer = false
            if userWantsServer && !server.isActive { server.start() }
        }
        refresh()
    }

    /// Reads `SMAppService.status` for both services. Side-effect free: a status read never
    /// installs anything.
    private func readServiceStates() {
        helperState = helperService?.state
        loginState = loginItem?.state
    }

    private var trayState: TrayState {
        if case .failed(let reason) = server.state { return .error(reason) }
        if isHealthy { return .running(aliasCount: status?.aliasCount ?? aliases.count) }
        if !userWantsServer { return .stopped }
        if server.consecutiveFailures >= 3 { return .error("server keeps exiting") }
        return .starting
    }

    private func refresh() {
        var model = MenuModel()
        model.state = trayState
        model.aliases = aliases
        model.status = status
        model.serverRunning = server.isActive || adoptedExternalServer
        model.controlsServer = !adoptedExternalServer
        model.helperService = helperState
        model.launchAtLogin = loginState
        statusMenu?.update(model)
    }

    // MARK: - StatusMenuDelegate

    func statusMenuWillOpen() {
        readServiceStates()
        refresh()
        poller.poll()
    }

    func statusMenuOpenDashboard() {
        NSWorkspace.shared.open(Paths.dashboardURL)
    }

    /// Opens the URL the API built, which already carries the scheme the helper is actually
    /// serving (`https://` once `config.https` is on, which is the default from Phase 4).
    /// Guessing a scheme here would open a port nothing is listening on.
    func statusMenuOpen(alias: Alias) {
        guard let url = URL(string: alias.url) else { return }
        NSWorkspace.shared.open(url)
    }

    /// The one privileged action in the app. Installs the root LaunchDaemon; macOS raises an
    /// administrator prompt and then lists it in System Settings › Login Items.
    func statusMenuInstallHelper() {
        guard let helperService else {
            present(title: "Cannot install the helper", message: """
                This copy of Localhost Aliases does not contain the helper daemon.

                Install the packaged app in /Applications, or in a development checkout run \
                the install script instead.
                """)
            return
        }
        do {
            try helperService.register()
        } catch {
            present(title: "Could not install the helper", message: error.localizedDescription)
            readServiceStates()
            refresh()
            return
        }
        // Never report success optimistically: read the status macOS ended up in and say
        // what it means — a fresh registration is normally `.requiresApproval`.
        readServiceStates()
        refresh()
        poller.poll()
        let state = helperState ?? .notRegistered
        present(
            title: state.summary(subject: .helper),
            message: state.explanation(subject: .helper),
            openSettings: state.needsUserApproval
        )
    }

    func statusMenuToggleLaunchAtLogin() {
        guard let loginItem else { return }
        do {
            if loginItem.state.isActive {
                try loginItem.unregister()
            } else {
                try loginItem.register()
            }
        } catch {
            present(title: "Could not change Launch at Login", message: error.localizedDescription)
        }
        readServiceStates()
        refresh()
        if loginState?.needsUserApproval == true {
            let state = ServiceState.requiresApproval
            present(
                title: state.summary(subject: .launchAtLogin),
                message: state.explanation(subject: .launchAtLogin),
                openSettings: true
            )
        }
    }

    func statusMenuOpenLoginItemsSettings() {
        ManagedService.openLoginItemsSettings()
    }

    func statusMenuCopyInstallCommand() {
        guard let command = status?.installCommand else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
    }

    func statusMenuRestartServer() {
        userWantsServer = true
        adoptedExternalServer = false
        isHealthy = false
        status = nil
        aliases = []
        server.restart()
        refresh()
    }

    func statusMenuToggleServer() {
        if server.isActive {
            userWantsServer = false
            isHealthy = false
            status = nil
            aliases = []
            server.stop()
        } else {
            userWantsServer = true
            server.start()
        }
        refresh()
    }

    func statusMenuOpenLog() {
        let log = Paths.webLog
        if FileManager.default.fileExists(atPath: log.path) {
            NSWorkspace.shared.open(log)
        } else {
            try? FileManager.default.createDirectory(at: Paths.logDirectory, withIntermediateDirectories: true)
            NSWorkspace.shared.open(Paths.logDirectory)
        }
    }

    func statusMenuQuit() {
        NSApp.terminate(nil)
    }

    // MARK: - Alerts

    /// An accessory app has no windows and is not frontmost, so an alert has to activate it
    /// or it opens behind whatever the user is looking at.
    private func present(title: String, message: String, openSettings: Bool = false) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .informational
        if openSettings {
            alert.addButton(withTitle: "Open System Settings")
            alert.addButton(withTitle: "Later")
            if alert.runModal() == .alertFirstButtonReturn { ManagedService.openLoginItemsSettings() }
            return
        }
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}
