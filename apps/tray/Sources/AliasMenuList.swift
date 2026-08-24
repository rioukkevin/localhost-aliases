import Foundation

/// Which aliases the menu shows — and what it says about the ones it does not.
///
/// The menu used to list `config.projectAliases`, i.e. all of them. That made it a worse copy
/// of the dashboard's list: most rows pointed at dev servers that were not running, and the
/// one question a menu bar answers well — *what can I click right now* — was buried in them.
/// The list is now the live aliases only.
///
/// Three judgement calls, written down so they can be argued with:
///
///   1. **The reserved dashboard alias is always listed**, answering or not. It is how you get
///      back into the app; a menu that can hide its own front door is not an improvement.
///   2. **Hidden is never silent.** A caption says how many are hidden and why. Someone who
///      just added an alias and does not see it must be told it is not answering, not left to
///      conclude it was lost.
///   3. **Nothing live is a sentence, not an empty region.** An empty area under a heading
///      reads as a bug.
///
/// "Live" is exactly what TrayState.aliasUp already means: something is listening on the
/// alias's target port. A disabled alias is never live — nothing forwards to it.
struct AliasMenuList {
    /// In menu order: the reserved dashboard alias first, then the live project aliases in
    /// config order.
    var shown: [AliasEntry] = []
    /// Project aliases left out because nothing is answering on their port.
    var hiddenCount: Int = 0
    /// Replaces the list when no project alias is live.
    var caption: String?
    /// Sits under the list when some are live and some are hidden.
    var hiddenNote: String?

    static func build(aliases: [AliasEntry], up: [String: Bool]) -> AliasMenuList {
        let reserved = aliases.filter { $0.reserved }
        let projects = aliases.filter { !$0.reserved }
        let live = projects.filter { isLive($0, up: up) }

        var list = AliasMenuList()
        list.shown = reserved + live
        list.hiddenCount = projects.count - live.count

        if live.isEmpty {
            list.caption =
                projects.isEmpty
                ? "No aliases yet — add one in the dashboard"
                : "\(none(projects.count)) answering right now — start a dev server"
        } else if list.hiddenCount > 0 {
            list.hiddenNote = "\(list.hiddenCount) more not answering — hidden"
        }
        return list
    }

    /// Enabled *and* something is listening. `aliasUp` has no entry for a disabled alias, so
    /// the two checks agree, but saying both makes the rule readable rather than incidental.
    static func isLive(_ alias: AliasEntry, up: [String: Bool]) -> Bool {
        alias.enabled && (up[alias.id] ?? false)
    }

    private static func none(_ count: Int) -> String {
        count == 1 ? "Your alias is not" : "None of your \(count) aliases is"
    }
}
