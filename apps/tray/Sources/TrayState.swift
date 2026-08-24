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
    /// Is the long-lived root agent up? Set from every completed poll — the agent IS the
    /// forwarder, so `forwarder-status.json` plus a live pid is the whole signal.
    var agent = AgentObservation.unobserved
    /// True once the single launch-time prompt has been raised in this session, however it
    /// was answered. Reset only by an explicit menu action, so a cancelled prompt never
    /// becomes a loop.
    var agentPromptRaised = false
    /// Real SMAppService.Status, or `.unknown` before the first read.
    var loginItem: LoginItemState = .unknown

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
            // The root agent is the thing that makes aliases work, so it leads. Once it is up
            // it reconciles desired-state.json by itself and nothing here needs a password.
            // The wording lives in AgentSupervisor, next to the decision it describes.
            if !system.forwarderRunning { return AgentSupervisor.statusLine(agent) }
            if system.needsPrompt || !system.applied { return "Root agent reconciling…" }
            return "Running — aliases applied"
        }
    }

    /// Shown under the status line while the agent is down: the one thing the user can do.
    var agentIsRunning: Bool { system.forwarderRunning }

    var iconKind: StatusIcon.Kind {
        switch dashboard {
        case .running:
            // Attention means "you have to do something": the agent is down and only the one
            // admin prompt can bring it back. Drift while the agent is up is not attention —
            // it reconciles on its own, and a permanent badge for that would be noise.
            if !system.forwarderRunning { return .attention }
            if !system.applied { return .attention }
            return system.dashboardReachable ? .live : .idle
        case .failed, .backingOff:
            return .attention
        case .stopped, .starting:
            return .idle
        }
    }
}
