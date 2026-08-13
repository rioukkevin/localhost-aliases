import Foundation

/// What the tray knows about the live system. Mirrors the useful half of `SystemState`
/// in packages/core/src/types.ts, plus whether the dashboard answered at all.
struct SystemSnapshot {
    var dashboardReachable = false
    var applied = false
    var drift: [String] = []
    /// True when the desired state needs the one admin prompt (StateDiff.needsPrompt).
    var needsPrompt = false
    var forwarderRunning = false
    var forwarderPid: Int?
    var checkedAt: Date?

    /// The dashboard alias only resolves once the hosts block and lo0 aliases are live.
    var canUseAliasURLs: Bool { applied && forwarderRunning }
}
