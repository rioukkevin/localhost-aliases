import AppKit

/// Actions the menu can trigger. AppDelegate implements them; MenuBuilder stays pure.
@objc protocol MenuActions: AnyObject {
    func openDashboard(_ sender: Any?)
    func openAlias(_ sender: Any?)
    func reapplyAliases(_ sender: Any?)
    func restartDashboard(_ sender: Any?)
    func openLoginItemSettings(_ sender: Any?)
    func uninstallEverything(_ sender: Any?)
    func quitApp(_ sender: Any?)
}

/// Builds the whole menu from a TrayState. No state of its own.
enum MenuBuilder {
    /// Rebuilds `menu` in place — NSMenu keeps its identity while it is open.
    static func populate(_ menu: NSMenu, state: TrayState, target: MenuActions) {
        menu.removeAllItems()
        menu.autoenablesItems = false

        menu.addItem(caption(state.statusLine, bold: true))
        for reason in state.system.drift.prefix(3) {
            menu.addItem(caption("· \(reason)"))
        }
        if let message = state.lastMessage {
            menu.addItem(caption(message))
        }

        menu.addItem(.separator())

        let open = NSMenuItem(
            title: "Open Dashboard", action: #selector(MenuActions.openDashboard(_:)),
            keyEquivalent: "")
        open.target = target
        open.toolTip = state.dashboardURL
        open.isEnabled = state.dashboardIsRunning
        menu.addItem(open)

        menu.addItem(.separator())
        menu.addItem(header("Live aliases"))

        // Only what is answering right now, plus the dashboard's own alias. The rule, the
        // wording and the reasoning all live in AliasMenuList, which is pure and tested.
        let list = AliasMenuList.build(aliases: state.config.aliases, up: state.aliasUp)
        for alias in list.shown {
            menu.addItem(aliasItem(alias, state: state, target: target))
        }
        if let text = list.caption { menu.addItem(caption(text)) }
        if let note = list.hiddenNote { menu.addItem(caption(note)) }
        menu.addItem(caption("http:// only — raw TCP forwarding can't terminate TLS"))

        menu.addItem(.separator())

        // One item, two jobs, because there are only two situations. With the agent up,
        // nothing here is routine — it reconciles by itself. With it down, this is the one
        // admin prompt, and the user has to be able to ask for it explicitly.
        let reapply = NSMenuItem(
            title: AgentSupervisor.actionTitle(agentRunning: state.agentIsRunning),
            action: #selector(MenuActions.reapplyAliases(_:)), keyEquivalent: "")
        reapply.target = target
        reapply.toolTip = AgentSupervisor.actionTooltip(agentRunning: state.agentIsRunning)
        reapply.isEnabled = !state.privilegedBusy
        menu.addItem(reapply)

        // Only ever shown for `.requiresApproval`. macOS accepted the registration but left it
        // switched off, so the app looks enabled and silently never launches. This is the one
        // login-item state a user cannot fix from inside the app.
        if state.loginItem.needsSystemSettings {
            let approve = NSMenuItem(
                title: "Approve Launch at Login…",
                action: #selector(MenuActions.openLoginItemSettings(_:)), keyEquivalent: "")
            approve.target = target
            approve.toolTip = state.loginItem.detail
            menu.addItem(approve)
        }

        let restart = NSMenuItem(
            title: "Restart Dashboard", action: #selector(MenuActions.restartDashboard(_:)),
            keyEquivalent: "")
        restart.target = target
        menu.addItem(restart)

        menu.addItem(.separator())

        let uninstall = NSMenuItem(
            title: "Uninstall…", action: #selector(MenuActions.uninstallEverything(_:)),
            keyEquivalent: "")
        uninstall.target = target
        uninstall.isEnabled = !state.privilegedBusy
        menu.addItem(uninstall)

        let quit = NSMenuItem(
            title: "Quit \(Paths.appName)", action: #selector(MenuActions.quitApp(_:)),
            keyEquivalent: "q")
        quit.target = target
        menu.addItem(quit)
    }

    // MARK: - Items

    private static func aliasItem(_ alias: AliasEntry, state: TrayState, target: MenuActions)
        -> NSMenuItem
    {
        let item = NSMenuItem(
            title: alias.hostname(tld: state.config.tld),
            action: #selector(MenuActions.openAlias(_:)), keyEquivalent: "")
        item.target = target
        item.representedObject = alias.url(tld: state.config.tld)
        item.isEnabled = alias.enabled
        item.toolTip = alias.description ?? alias.url(tld: state.config.tld)
        item.attributedTitle = aliasTitle(alias, state: state)
        return item
    }

    private static func aliasTitle(_ alias: AliasEntry, state: TrayState) -> NSAttributedString {
        let up = state.aliasUp[alias.id] ?? false
        let dotColor: NSColor =
            !alias.enabled ? .tertiaryLabelColor : (up ? .systemGreen : .systemOrange)

        let title = NSMutableAttributedString()
        title.append(
            NSAttributedString(
                string: "● ",
                attributes: [
                    .foregroundColor: dotColor,
                    .font: NSFont.systemFont(ofSize: 9),
                ]))
        title.append(
            NSAttributedString(
                string: alias.hostname(tld: state.config.tld),
                attributes: [.font: NSFont.menuFont(ofSize: 0)]))
        title.append(
            NSAttributedString(
                string: "  :\(alias.port)",
                attributes: [
                    .foregroundColor: NSColor.secondaryLabelColor,
                    .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
                ]))
        return title
    }

    private static func header(_ text: String) -> NSMenuItem {
        let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        item.isEnabled = false
        item.attributedTitle = NSAttributedString(
            string: text.uppercased(),
            attributes: [
                .foregroundColor: NSColor.tertiaryLabelColor,
                .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
                .kern: 0.8,
            ])
        return item
    }

    private static func caption(_ text: String, bold: Bool = false) -> NSMenuItem {
        let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        item.isEnabled = false
        item.attributedTitle = NSAttributedString(
            string: text,
            attributes: [
                .foregroundColor: bold ? NSColor.labelColor : NSColor.secondaryLabelColor,
                .font: NSFont.systemFont(
                    ofSize: bold ? 12 : 11, weight: bold ? .semibold : .regular),
            ])
        return item
    }
}
