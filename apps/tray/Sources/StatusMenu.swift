import AppKit

/// Everything the menu can ask the app to do.
protocol StatusMenuDelegate: AnyObject {
    func statusMenuOpenDashboard()
    func statusMenuOpen(alias: Alias)
    func statusMenuInstallHelper()
    func statusMenuOpenLoginItemsSettings()
    func statusMenuCopyInstallCommand()
    func statusMenuToggleLaunchAtLogin()
    func statusMenuRestartServer()
    func statusMenuToggleServer()
    func statusMenuOpenLog()
    func statusMenuQuit()
    /// Chance to refresh data before the menu is drawn.
    func statusMenuWillOpen()
}

/// Everything the menu renders. Assembled by `AppDelegate` from observed state only — there is
/// no optimistic field in here on purpose: an action re-polls and the menu redraws from what
/// came back.
struct MenuModel {
    var state: TrayState = .starting
    var aliases: [Alias] = []
    /// `nil` while the dashboard is unreachable: the menu then says so rather than inventing.
    var status: SystemStatusSummary?
    var serverRunning = false
    /// False when the server was started outside the tray — we can't stop what we don't own.
    var controlsServer = true
    /// `nil` when this build cannot install the daemon at all (checkout build, damaged bundle).
    var helperService: ServiceState?
    /// `nil` when not running from a `.app`, where launch-at-login is meaningless.
    var launchAtLogin: ServiceState?

    /// The bundle can install the daemon *and* the API says one is missing.
    var offersHelperInstall: Bool {
        guard let status, status.helperMissing else { return false }
        return status.installMethod == .bundle && helperService != nil
    }

    /// Dev installs get the copyable `sudo …` line instead — never an install button.
    var offersInstallCommand: Bool {
        guard let status, status.helperMissing else { return false }
        return status.installMethod == .script && status.installCommand != nil
    }
}

/// The `NSStatusItem` and its menu. Pure presentation: it renders whatever state it is
/// handed and forwards clicks to its delegate.
final class StatusMenu: NSObject, NSMenuDelegate {
    /// Longer alias lists get truncated — a menu bar menu is not a dashboard.
    private static let maximumAliasesShown = 14

    weak var delegate: StatusMenuDelegate?

    private let statusItem: NSStatusItem
    private let menu = NSMenu()
    private var appearanceObservation: NSKeyValueObservation?
    private var model = MenuModel()

    init(delegate: StatusMenuDelegate) {
        self.delegate = delegate
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()

        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu
        statusItem.button?.imagePosition = .imageOnly

        // A drawing-handler image must be rebuilt when the menu bar flips light/dark.
        appearanceObservation = statusItem.button?.observe(\.effectiveAppearance) { [weak self] _, _ in
            self?.applyIcon()
        }

        render()
    }

    func update(_ model: MenuModel) {
        self.model = model
        render()
    }

    // MARK: - Rendering

    private func render() {
        applyIcon()
        statusItem.button?.toolTip = model.state.accessibilityDescription
        rebuildMenu()
    }

    private func applyIcon() {
        statusItem.button?.image = StatusIcon.image(for: model.state)
    }

    private func rebuildMenu() {
        menu.removeAllItems()

        menu.addItem(disabledItem(title: model.state.statusLine, bold: true))
        menu.addItem(disabledItem(title: helperLine(), bold: false))
        menu.addItem(.separator())
        menu.addItem(actionItem("Open Dashboard", #selector(openDashboard), key: "d"))

        menu.addItem(.separator())
        appendAliasSection()

        appendHelperSection()

        menu.addItem(.separator())
        menu.addItem(launchAtLoginItem())

        let restart = actionItem("Restart Server", #selector(restartServer), key: "r")
        restart.isEnabled = model.controlsServer
        menu.addItem(restart)

        let toggle = actionItem(model.serverRunning ? "Stop Server" : "Start Server", #selector(toggleServer))
        toggle.isEnabled = model.controlsServer
        if !model.controlsServer {
            toggle.toolTip = "The web server was started outside the tray (LaunchAgent or dev script)."
        }
        menu.addItem(toggle)

        menu.addItem(.separator())
        menu.addItem(actionItem("Open Server Log", #selector(openLog)))
        menu.addItem(actionItem("Quit Localhost Aliases", #selector(quit), key: "q"))
    }

    /// Second line: the state of the thing that actually makes aliases resolve.
    private func helperLine() -> String {
        guard let status = model.status else { return "Helper: unknown — dashboard unreachable" }
        // A service awaiting approval is installed as far as launchd is concerned but will
        // never run, so say the actionable thing instead of "not running".
        if let service = model.helperService, service.needsUserApproval {
            return "Helper: waiting for your approval in System Settings"
        }
        return status.helperLine
    }

    private func appendAliasSection() {
        menu.addItem(sectionHeader("Aliases"))

        guard !model.aliases.isEmpty else {
            let placeholder: String
            switch model.state {
            case .running: placeholder = "No aliases yet — add one in the dashboard"
            case .starting: placeholder = "Waiting for the server…"
            case .stopped: placeholder = "Server stopped"
            case .error: placeholder = "Unavailable"
            }
            menu.addItem(disabledItem(title: placeholder, bold: false))
            return
        }

        for alias in model.aliases.prefix(Self.maximumAliasesShown) {
            let item = actionItem(alias.hostname, #selector(openAlias(_:)))
            item.attributedTitle = aliasTitle(alias)
            item.image = StatusIcon.aliasDot(status: alias.status)
            item.toolTip = alias.url
            item.representedObject = alias
            item.isEnabled = alias.enabled
            menu.addItem(item)
        }

        let hidden = model.aliases.count - Self.maximumAliasesShown
        if hidden > 0 {
            menu.addItem(disabledItem(title: "+\(hidden) more in the dashboard", bold: false))
        }
    }

    /// Only present when there is something to do about the helper.
    private func appendHelperSection() {
        if model.offersHelperInstall {
            menu.addItem(.separator())
            let install = actionItem("Install Helper…", #selector(installHelper))
            install.toolTip = "Installs the privileged helper as a system daemon. Asks for your administrator password once."
            menu.addItem(install)
        } else if model.offersInstallCommand {
            menu.addItem(.separator())
            let copyItem = actionItem("Copy Install Command", #selector(copyInstallCommand))
            copyItem.toolTip = model.status?.installCommand
            menu.addItem(copyItem)
        }

        if model.helperService?.needsUserApproval == true || model.launchAtLogin?.needsUserApproval == true {
            if !model.offersHelperInstall && !model.offersInstallCommand { menu.addItem(.separator()) }
            menu.addItem(actionItem("Approve in System Settings…", #selector(openLoginItemsSettings)))
        }
    }

    /// Reflects the real `SMAppService` status, never what we last asked for.
    private func launchAtLoginItem() -> NSMenuItem {
        let item = actionItem("Launch at Login", #selector(toggleLaunchAtLogin))
        guard let state = model.launchAtLogin else {
            item.isEnabled = false
            item.toolTip = "Available once the app is installed in /Applications and launched from there."
            return item
        }
        switch state {
        case .enabled:
            item.state = .on
        case .requiresApproval:
            // Mixed, not on: it is registered but macOS will not run it yet.
            item.state = .mixed
        case .notRegistered, .notFound, .unknown:
            item.state = .off
        }
        item.toolTip = state.summary(subject: .launchAtLogin)
        return item
    }

    /// `myapp.local` in mono (the hero element), the port trailing and muted.
    private func aliasTitle(_ alias: Alias) -> NSAttributedString {
        let size = NSFont.systemFontSize
        let title = NSMutableAttributedString(
            string: alias.hostname,
            attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: size, weight: .regular),
                .foregroundColor: alias.enabled ? NSColor.labelColor : NSColor.tertiaryLabelColor,
            ]
        )
        title.append(NSAttributedString(
            string: "  :\(alias.port)",
            attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: size - 1, weight: .regular),
                .foregroundColor: NSColor.secondaryLabelColor,
            ]
        ))
        return title
    }

    private func sectionHeader(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        item.attributedTitle = NSAttributedString(
            string: title.uppercased(),
            attributes: [
                .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize, weight: .semibold),
                .foregroundColor: NSColor.secondaryLabelColor,
                .kern: 0.6,
            ]
        )
        return item
    }

    private func disabledItem(title: String, bold: Bool) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        if bold {
            item.attributedTitle = NSAttributedString(
                string: title,
                attributes: [
                    .font: NSFont.systemFont(ofSize: NSFont.systemFontSize, weight: .semibold),
                    .foregroundColor: NSColor.labelColor,
                ]
            )
        }
        return item
    }

    private func actionItem(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.isEnabled = true
        return item
    }

    // MARK: - NSMenuDelegate

    func menuWillOpen(_ menu: NSMenu) {
        delegate?.statusMenuWillOpen()
    }

    // MARK: - Actions

    @objc private func openDashboard() { delegate?.statusMenuOpenDashboard() }
    @objc private func installHelper() { delegate?.statusMenuInstallHelper() }
    @objc private func copyInstallCommand() { delegate?.statusMenuCopyInstallCommand() }
    @objc private func openLoginItemsSettings() { delegate?.statusMenuOpenLoginItemsSettings() }
    @objc private func toggleLaunchAtLogin() { delegate?.statusMenuToggleLaunchAtLogin() }
    @objc private func restartServer() { delegate?.statusMenuRestartServer() }
    @objc private func toggleServer() { delegate?.statusMenuToggleServer() }
    @objc private func openLog() { delegate?.statusMenuOpenLog() }
    @objc private func quit() { delegate?.statusMenuQuit() }

    @objc private func openAlias(_ sender: NSMenuItem) {
        guard let alias = sender.representedObject as? Alias else { return }
        delegate?.statusMenuOpen(alias: alias)
    }
}
