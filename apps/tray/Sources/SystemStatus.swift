import Foundation

/// How the privileged helper gets installed on this deployment (`docs/PHASE4.md` §2).
enum HelperInstallMethod: String, Decodable {
    /// Production: the tray registers a LaunchDaemon with `SMAppService`.
    case bundle
    /// Development: `sudo ./scripts/install.sh`. The tray must not offer to install anything.
    case script
}

/// The slice of `GET /api/status` the menu bar needs.
///
/// Decoding is deliberately forgiving in both directions: a field the API has not shipped yet
/// (`helper.installMethod` arrives with Phase 4) must not blank the menu, and neither must one
/// it drops later.
struct SystemStatusSummary: Decodable, Equatable {
    let aliasCount: Int
    let https: Bool
    let helperInstalled: Bool
    let helperRunning: Bool
    let helperReason: String?
    let installMethod: HelperInstallMethod
    /// `commands.install` — the copyable `sudo …` line, dev installs only.
    let installCommand: String?

    /// True when the helper is not usable, whatever the reason. Drives "Install Helper…".
    var helperMissing: Bool { !helperInstalled || !helperRunning }

    var helperLine: String {
        if helperInstalled && helperRunning { return "Helper: running" }
        if helperInstalled { return "Helper: installed, not running" }
        return "Helper: not installed"
    }

    private enum Root: String, CodingKey { case aliasCount, https, helper, commands }
    private enum Helper: String, CodingKey { case installed, running, reason, installMethod }
    private enum Commands: String, CodingKey { case install }

    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Root.self)
        aliasCount = try root.decodeIfPresent(Int.self, forKey: .aliasCount) ?? 0
        https = try root.decodeIfPresent(Bool.self, forKey: .https) ?? false

        let helper = try? root.nestedContainer(keyedBy: Helper.self, forKey: .helper)
        helperInstalled = optional(Bool.self, .installed, in: helper) ?? false
        helperRunning = optional(Bool.self, .running, in: helper) ?? false
        helperReason = optional(String.self, .reason, in: helper)
        // An absent installMethod means an API that predates Phase 4, i.e. a dev checkout:
        // never offer to install a daemon on a guess.
        installMethod = optional(String.self, .installMethod, in: helper)
            .flatMap(HelperInstallMethod.init(rawValue:)) ?? .script

        let commands = try? root.nestedContainer(keyedBy: Commands.self, forKey: .commands)
        installCommand = optional(String.self, .install, in: commands)
    }

    /// Test seam.
    init(
        aliasCount: Int,
        https: Bool,
        helperInstalled: Bool,
        helperRunning: Bool,
        helperReason: String?,
        installMethod: HelperInstallMethod,
        installCommand: String?
    ) {
        self.aliasCount = aliasCount
        self.https = https
        self.helperInstalled = helperInstalled
        self.helperRunning = helperRunning
        self.helperReason = helperReason
        self.installMethod = installMethod
        self.installCommand = installCommand
    }
}

/// Reads one optional field out of an optional container without any of it being fatal.
private func optional<T: Decodable, K: CodingKey>(
    _ type: T.Type,
    _ key: K,
    in container: KeyedDecodingContainer<K>?
) -> T? {
    guard let container else { return nil }
    return (try? container.decodeIfPresent(type, forKey: key)) ?? nil
}
