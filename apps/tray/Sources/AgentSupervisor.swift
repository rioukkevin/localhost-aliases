import Darwin
import Foundation

// =============================================================================================
//  The root-agent model, from the tray's side (docs/AGENT.md §1).
//
//  BEFORE: every hostname/IP change raised an admin prompt. Unusable at the rate people add
//  aliases.
//  NOW:    ONE admin prompt, at app launch, starts a long-lived root process — the agent. It
//          watches desired-state.json and reconciles lo0, the /etc/hosts block, DNS and the
//          forwarder routes on its own. It exits by itself when the heartbeat goes stale.
//
//  So the tray's job changed shape. It no longer asks for a password per mutation; it asks
//  once, and afterwards it only has to answer one question: is the agent up?
//
//  Everything here is a pure function of observed state. It cannot prompt — the caller owns
//  the runner — which is why apps/tray/tests can exercise every branch with no chance of a
//  password dialog.
// =============================================================================================

/// What the tray has observed about the root agent. Assembled from `forwarder-status.json`
/// (pid, liveness) by StatusPoller — the agent IS the forwarder, one root process, not two.
struct AgentObservation: Equatable {
    /// False until the first poll lands. "Not observed yet" is not "not running".
    var observed = false
    var running = false

    static let unobserved = AgentObservation()
    static func seen(running: Bool) -> AgentObservation {
        AgentObservation(observed: true, running: running)
    }
}

/// Whether the one launch-time prompt should be raised now, and if not, why not.
enum AgentStartDecision: Equatable {
    /// No poll has landed yet. Deciding on no evidence would prompt for nothing.
    case waitForObservation
    /// The agent is up. This is the steady state, and the whole point: no prompt.
    case running
    /// Fresh install — no config, or no aliases yet. Onboarding owns the first prompt and
    /// explains what is about to change before anything happens (docs/V2.md).
    case deferToOnboarding
    /// Already raised once this session. A second dialog for the same launch is the bug the
    /// root agent exists to remove; the menu's explicit action is how a user retries.
    case alreadyAsked
    /// A privileged run is on screen. ApplyRequestWatcher enforces the same rule for the
    /// dashboard's channel; both funnel through AppDelegate.privilegedBusy.
    case busy
    /// LA_NO_PRIVILEGED or LA_NO_AGENT_AUTOSTART is set.
    case disabled
    /// Raise the single prompt.
    case start
}

/// How a privileged request from the dashboard should be served now that the agent exists.
enum AgentApplyRouting: Equatable {
    /// No prompt: write desired-state.json and the running agent reconciles it. This is what
    /// makes "add an alias" free after the first launch.
    case agentReconciles
    /// The agent is not up (or this is an uninstall, which must remove what root created and
    /// stop the agent). The one prompt is unavoidable and honest.
    case needsPrompt
}

/// Is the root agent alive, right now? Read fresh from disk rather than from the 3s poll,
/// because "is it still up?" is asked at the moment a decision depends on the answer.
enum AgentProbe {
    /// The pid the agent published, or nil when it never published one.
    static func pid(at path: String = Paths.forwarderStatusPath) -> Int32? {
        guard let data = FileManager.default.contents(atPath: path),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let pid = object["pid"] as? Int, pid > 0
        else { return nil }
        return Int32(pid)
    }

    /// Signal 0 delivers nothing; it only asks whether the pid exists. EPERM means it exists
    /// and belongs to root — which is exactly what the agent is.
    static func isAlive(pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        if kill(pid, 0) == 0 { return true }
        return errno == EPERM
    }

    static func isRunning(at path: String = Paths.forwarderStatusPath) -> Bool {
        guard let pid = pid(at: path) else { return false }
        return isAlive(pid: pid)
    }
}

enum AgentSupervisor {
    /// True unless a developer has switched the launch-time prompt off. Two switches: the
    /// existing global kill switch, plus one that leaves the rest of the app alone.
    static var autoStartEnabled: Bool {
        Paths.env("LA_NO_PRIVILEGED") == nil && Paths.env("LA_NO_AGENT_AUTOSTART") == nil
    }

    /// Should the tray raise the single admin prompt right now?
    ///
    /// Order matters and is deliberate: the cheap "nothing to do" answers come first, so the
    /// only way to reach `.start` is past every reason not to.
    static func decideStart(
        observation: AgentObservation,
        hasConfig: Bool,
        hasAliases: Bool,
        askedThisSession: Bool,
        busy: Bool,
        autoStartEnabled: Bool
    ) -> AgentStartDecision {
        guard observation.observed else { return .waitForObservation }
        if observation.running { return .running }
        guard hasConfig, hasAliases else { return .deferToOnboarding }
        guard autoStartEnabled else { return .disabled }
        if askedThisSession { return .alreadyAsked }
        if busy { return .busy }
        return .start
    }

    /// A dashboard request arrived. Under the root-agent model an `apply` is only a prompt
    /// when there is no agent to do the reconciling.
    static func route(kind: PrivilegedRequestKind, agentRunning: Bool) -> AgentApplyRouting {
        switch kind {
        case .uninstall:
            // Removing the /etc/hosts block and the lo0 addresses is root's work no matter
            // who is running, and the agent must be stopped rather than asked politely.
            return .needsPrompt
        case .apply:
            return agentRunning ? .agentReconciles : .needsPrompt
        }
    }

    /// What the dashboard is told when a mutation needed no prompt at all. It is written into
    /// apply-result.json, so it has to explain itself without a UI around it.
    static let reconciledMessage =
        "The root agent picked this up from desired-state.json — no password needed."

    /// The menu item's title. One item, two jobs, because there are only two situations —
    /// and when the agent is down the user MUST have an explicit way to ask for the prompt.
    static func actionTitle(agentRunning: Bool) -> String {
        agentRunning ? "Re-apply Aliases…" : "Start the Root Agent…"
    }

    static func actionTooltip(agentRunning: Bool) -> String {
        agentRunning
            ? "Rarely needed — the root agent already applies changes on its own. "
                + "This asks for your administrator password once and re-applies everything."
            : "Asks for your administrator password once and starts the root agent. "
                + "After that, adding or changing aliases needs no password."
    }

    /// One line for the menu, matching docs/DESIGN.md's voice: state what is true, do not
    /// dress it up.
    static func statusLine(_ observation: AgentObservation) -> String {
        guard observation.observed else { return "Checking the root agent…" }
        return observation.running
            ? "Root agent running — changes apply without a prompt"
            : "Root agent not running — aliases will not resolve"
    }
}
