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
    private var applyWatcher: ApplyRequestWatcher!
    private var loginItemWatcher: LoginItemWatcher!
    private var termination: TerminationCoordinator?
    private var signalSources: [DispatchSourceSignal] = []

    private var state = TrayState()
    private var isTerminating = false
    /// Last agent decision we logged, so a 3s poll cannot fill the log with the same line.
    private var lastAgentDecision: AgentStartDecision?

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
            // A completed poll is an observation either way: "no agent" is an answer, not a
            // silence. Everything about the launch prompt hangs off this.
            self.state.agent = AgentObservation.seen(running: snapshot.forwarderRunning)
            self.refreshIcon()
            self.considerStartingAgent()
        }
        poller.start()

        // The dashboard cannot raise an admin prompt, so it asks us to. See
        // ApplyRequestWatcher.swift; this is the only other way into runPrivileged.
        applyWatcher = ApplyRequestWatcher(
            log: log,
            isBusy: { [weak self] in self?.state.privilegedBusy ?? true },
            run: { [weak self] kind, completion in
                guard let self else {
                    completion(
                        PrivilegedRunOutcome(ok: false, cancelled: false, output: "tray is shutting down"))
                    return
                }
                self.serveRequest(kind, completion: completion)
            })
        applyWatcher.start()

        // Launch at login. Reading the status prompts for nothing and changes nothing; the
        // watcher is the only route to register(), and it needs a fresh request id written by
        // an explicit click in the dashboard's settings drawer. See LoginItemService.swift.
        loginItemWatcher = LoginItemWatcher(
            log: log,
            read: { LoginItemService.currentState() },
            apply: { [log] action, done in
                LoginItemService.apply(action, log: log, completion: done)
            },
            onStateChange: { [weak self] newState in
                guard let self else { return }
                self.state.loginItem = newState
                self.log.log("login-item: \(newState.rawValue) — \(newState.headline)")
            })
        loginItemWatcher.start()
        state.loginItem = loginItemWatcher.state

        installSignalHandlers()
        openDashboardOnFirstRun()
    }

    // MARK: - The root agent

    /// docs/AGENT.md §1: ONE admin prompt, at app launch, starts the long-lived root agent.
    /// After that it reconciles desired-state.json on its own and nothing here prompts again.
    ///
    /// Called from every poll, but `AgentSupervisor.decideStart` is what makes that safe:
    /// `.start` is reachable only once per session, only after a real observation, only when
    /// the user has already been onboarded, and never while another prompt is on screen.
    private func considerStartingAgent() {
        let decision = AgentSupervisor.decideStart(
            observation: state.agent,
            hasConfig: FileManager.default.fileExists(atPath: Paths.configPath),
            hasAliases: !state.config.aliases.isEmpty,
            askedThisSession: state.agentPromptRaised,
            busy: state.privilegedBusy,
            autoStartEnabled: AgentSupervisor.autoStartEnabled)

        if decision != lastAgentDecision {
            lastAgentDecision = decision
            log.log("agent: \(decision)")
        }
        guard decision == .start else { return }

        // Set BEFORE the run, exactly as ApplyRequestWatcher does: a poll that fires while the
        // password dialog is on screen must not be able to start a second one.
        state.agentPromptRaised = true
        log.log("agent: not running — raising the single admin prompt that starts it")
        runPrivileged(.apply)
    }

    /// The dashboard asked for privileged work. Under the root-agent model most of those
    /// requests need no password at all: the agent is already running as root and watching
    /// `desired-state.json`, which the dashboard has already written.
    private func serveRequest(
        _ kind: PrivilegedRequestKind, completion: @escaping (PrivilegedRunOutcome) -> Void
    ) {
        // Read fresh, not from the 3s poll: the answer decides whether a user gets a password
        // dialog or not, and a stale "yes" would report success for work nobody did.
        let agentRunning = AgentProbe.isRunning()
        state.agent = AgentObservation.seen(running: agentRunning)

        switch AgentSupervisor.route(kind: kind, agentRunning: agentRunning) {
        case .agentReconciles:
            log.log("apply-watcher: \(kind.rawValue) needs no prompt — the root agent is running")
            state.lastMessage = nil
            poller.refreshSoon()
            completion(
                PrivilegedRunOutcome(
                    ok: true, cancelled: false, output: AgentSupervisor.reconciledMessage))
        case .needsPrompt:
            // An uninstall is not an apply with a different flag: it is the whole teardown,
            // it ends with this app deleting itself, and it must be confirmed in the app that
            // does it. So the channel is answered NOW — "we have taken over" — and the
            // confirmation, the prompt and the report all happen here.
            //
            // Answering first also keeps the config directory clean: a result written after
            // the teardown would recreate ~/.config/localhost-aliases seconds after removing it.
            if kind == .uninstall {
                log.log("apply-watcher: uninstall requested from the dashboard — confirming in the app")
                completion(
                    PrivilegedRunOutcome(
                        ok: true, cancelled: false,
                        output: "The menu-bar app is asking you to confirm the uninstall."))
                uninstallEverything(nil)
                return
            }
            // No agent: this is the one prompt, and the request the user just made is the
            // reason for it. It counts as this session's ask.
            state.agentPromptRaised = true
            runPrivileged(.apply) { result in
                completion(
                    PrivilegedRunOutcome(
                        ok: result.ok, cancelled: result.cancelled, output: result.output))
            }
        }
    }

    /// The app has no Dock icon and never opens a window, so on a genuine first run nothing
    /// visibly happens and the menu-bar icon is easy to miss. If there is no config yet, wait
    /// for the dashboard to answer and open onboarding once. Subsequent launches stay silent.
    private func openDashboardOnFirstRun() {
        guard !FileManager.default.fileExists(atPath: Paths.configPath) else { return }
        log.log("first run: no config yet, will open the dashboard once it is ready")
        waitForDashboard(attemptsLeft: 60)
    }

    private func waitForDashboard(attemptsLeft: Int) {
        guard attemptsLeft > 0 else {
            log.log("first run: dashboard did not answer in time; use the menu-bar icon")
            return
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self else { return }
            if PortProbe.isOpen(port: self.state.config.dashboardPort) {
                DispatchQueue.main.async { self.open(urlString: self.state.dashboardURL) }
            } else {
                self.waitForDashboard(attemptsLeft: attemptsLeft - 1)
            }
        }
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

    /// Shutting down used to hang here, needing SIGKILL — and a wedged tray blocks
    /// `make install`, which refuses to replace a running app. Three rules now hold on every
    /// path, and TerminationCoordinator.swift is where they are enforced and tested:
    ///
    ///   1. the reply is never delivered before this method has RETURNED `.terminateLater`
    ///      (`begin` defers arming to a later main run-loop turn, and `DashboardProcess.stop`
    ///      no longer calls its completion inline);
    ///   2. it is delivered exactly once, even if a child reports twice or not at all;
    ///   3. if AppKit still will not tear the process down, the exit watchdog does.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !isTerminating else { return .terminateNow }
        isTerminating = true
        log.log("tray: shutting down")

        let coordinator = TerminationCoordinator(
            log: { [weak self] message in self?.log.log(message) },
            reply: { NSApp.reply(toApplicationShouldTerminate: true) },
            hardExit: { [weak self] in self?.hardExit() })
        termination = coordinator
        coordinator.begin(waitingFor: ["dashboard"])

        applyWatcher?.stop()
        loginItemWatcher?.stop()
        poller?.stop()
        // Removes the liveness file -> the root agent exits on its own. Nothing is left
        // running as root, with no password needed to stop it.
        heartbeat?.stop()

        if let dashboard {
            dashboard.stop { coordinator.finished("dashboard") }
        } else {
            // Never started (a failed launch). Reporting inline is safe precisely because the
            // coordinator has not armed yet — that is the whole point of arming late.
            coordinator.finished("dashboard")
        }
        return .terminateLater
    }

    /// Last resort for the exit watchdog. Everything that outlives the process is dealt with
    /// first: the liveness file (so the root agent exits on its own) and our own child.
    private func hardExit() {
        heartbeat?.stop()
        dashboard?.forceKill()
        log.log("tray: AppKit did not terminate — exiting the hard way")
        log.flush()
        exit(0)
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
    ///
    /// Also the explicit "start the agent" action: when the agent is down this is how a user
    /// asks for the prompt back after cancelling it, or after the agent exited (a stale
    /// heartbeat, a reboot). Doing it by hand is the only retry — the app never re-raises a
    /// dialog the user dismissed.
    func reapplyAliases(_ sender: Any?) {
        let running = state.agentIsRunning
        let confirmed = confirm(
            title: running ? "Re-apply aliases?" : "Start the root agent?",
            body: running
                ? "This is rarely needed — the root agent already applies changes on its own. "
                    + "macOS will ask for your administrator password once, then /etc/hosts, the "
                    + "lo0 addresses, DNS and the routes are re-applied. Nothing is installed "
                    + "permanently."
                : "macOS will ask for your administrator password once. That starts the root "
                    + "agent, which sets up /etc/hosts, the loopback addresses on lo0 and the "
                    + "forwarder, and then keeps them in step with your aliases without asking "
                    + "again. It exits by itself when you quit this app. Nothing is installed "
                    + "permanently.",
            action: running ? "Re-apply" : "Start")
        guard confirmed else { return }
        state.agentPromptRaised = true
        runPrivileged(.apply)
    }

    /// Not privileged, and deliberately not a toggle: the toggle lives in the dashboard's
    /// settings drawer. This is the escape hatch for `.requiresApproval`, the one login-item
    /// state that can only be fixed in System Settings.
    func openLoginItemSettings(_ sender: Any?) {
        open(urlString: LoginItemState.systemSettingsURL)
    }

    /// Privileged action #2 of 2, and the only one that ends with this app deleting itself.
    ///
    /// The whole teardown lives in the shipped teardown.sh — the same file `make uninstall`
    /// runs — so this works on a machine with no source code on it, which is the point.
    /// Reachable from the menu item and from the dashboard's settings drawer; both land here,
    /// so there is exactly one confirmation and one report however it was started.
    func uninstallEverything(_ sender: Any?) {
        guard !state.privilegedBusy else {
            log.log("uninstall: ignored — a privileged run is already on screen")
            return
        }
        let confirmed = confirm(
            title: Uninstaller.confirmTitle,
            body: Uninstaller.confirmBody(aliasCount: state.config.projectAliases.count),
            action: "Uninstall",
            destructive: true)
        guard confirmed else { return }
        runUninstall()
    }

    /// Order matters here. The dashboard is the process that writes into
    /// ~/.config/localhost-aliases, so it is stopped BEFORE the directory is removed —
    /// otherwise it recreates the files a second after the uninstall deleted them. If the
    /// password prompt is dismissed, nothing was removed and it is simply started again.
    private func runUninstall() {
        state.privilegedBusy = true
        state.lastMessage = "Uninstalling…"
        applyWatcher?.stop()
        loginItemWatcher?.stop()
        poller?.stop()
        dashboard?.stop()

        PrivilegedApply.runTeardown(
            layout: layout,
            appBundle: layout.appBundle,
            waitPid: getpid(),
            log: log
        ) { [weak self] report, result in
            guard let self else { return }
            self.state.privilegedBusy = false

            if report.outcome == .cancelled || result.cancelled {
                self.log.log("uninstall: cancelled at the password prompt — nothing was removed")
                self.state.lastMessage = "Cancelled — nothing was removed"
                self.applyWatcher?.start()
                self.loginItemWatcher?.start()
                self.poller?.start()
                self.dashboard?.start(port: self.state.config.dashboardPort)
                self.refreshIcon()
                return
            }

            // Every step's outcome, failures included. A teardown that hides what it could not
            // do leaves the user believing their machine is clean when it is not.
            self.presentReport(report)
            NSApp.terminate(nil)
        }
    }

    private func presentReport(_ report: Uninstaller.Report) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = Uninstaller.resultTitle(report)
        alert.informativeText = Uninstaller.resultBody(report)
        alert.alertStyle = report.outcome == .ok ? .informational : .warning
        alert.addButton(withTitle: "Quit")
        alert.runModal()
    }

    func quitApp(_ sender: Any?) {
        NSApp.terminate(nil)
    }

    // MARK: - Helpers

    /// The single entry to the admin prompt, shared by the two menu items and by the
    /// dashboard's request channel. `completion` runs on the main thread before any
    /// termination, so an uninstall still gets its result written to disk.
    private func runPrivileged(
        _ kind: PrivilegedApply.Kind,
        completion: ((PrivilegedApply.Result) -> Void)? = nil
    ) {
        state.privilegedBusy = true
        state.lastMessage = kind == .apply ? "Applying…" : "Uninstalling…"
        PrivilegedApply.run(layout: layout, kind: kind, log: log) { [weak self] result in
            guard let self else {
                completion?(result)
                return
            }
            self.state.privilegedBusy = false
            completion?(result)
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
