import Foundation

/// Everything the menu renders from. Owned by AppDelegate, mutated only on the main thread.
struct TrayState {
    var config = AppConfig.fallback
    var dashboard: DashboardProcess.State = .stopped
    var system = SystemSnapshot()
    /// alias id -> is something listening on its target port
    var aliasUp: [String: Bool] = [:]
    /// True while the admin prompt is on screen; the privileged menu items disable themselves.
    var privilegedBusy = false
    var lastMessage: String?

    var dashboardIsRunning: Bool {
        if case .running = dashboard { return true }
        return false
    }

    /// Requirement 6: prefer the alias, fall back to the loopback port only when the alias
    /// cannot possibly resolve yet.
    var dashboardURL: String {
        system.canUseAliasURLs
            ? "http://\(config.dashboardHostname)"
            : config.loopbackDashboardURL
    }

    var statusLine: String {
        switch dashboard {
        case .failed(let reason):
            return "Dashboard failed — \(reason)"
        case .stopped:
            return "Stopped"
        case .starting:
            return "Dashboard starting…"
        case .backingOff(let seconds):
            return "Dashboard crashed — retrying in \(seconds)s"
        case .running:
            if !system.dashboardReachable { return "Dashboard starting…" }
            if system.needsPrompt || !system.applied { return "Drift pending — needs admin" }
            if !system.forwarderRunning { return "Applied — forwarder not running" }
            return "Running — aliases applied"
        }
    }

    var iconKind: StatusIcon.Kind {
        switch dashboard {
        case .running:
            if system.needsPrompt || !system.applied { return .attention }
            return system.dashboardReachable ? .live : .idle
        case .failed, .backingOff:
            return .attention
        case .stopped, .starting:
            return .idle
        }
    }
}
