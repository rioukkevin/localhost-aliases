import Foundation

// =============================================================================================
//  The root-agent model, from the tray's side (docs/AGENT.md §1).
//
//  What has to be true:
//    * ONE admin prompt, at app launch, and never a second one in the same session;
//    * no prompt at all for a mutation once the agent is running — that is the whole point;
//    * an explicit way to ask for the prompt when the agent is NOT running;
//    * uninstall still prompts, because removing what root created is root's work.
//
//  `decideStart` and `route` are pure, and the prompt itself lives behind an injected runner,
//  so none of this can raise a dialog.
// =============================================================================================

private func decide(
    observed: Bool = true,
    running: Bool = false,
    hasConfig: Bool = true,
    hasAliases: Bool = true,
    asked: Bool = false,
    busy: Bool = false,
    autoStart: Bool = true
) -> AgentStartDecision {
    AgentSupervisor.decideStart(
        observation: AgentObservation(observed: observed, running: running),
        hasConfig: hasConfig,
        hasAliases: hasAliases,
        askedThisSession: asked,
        busy: busy,
        autoStartEnabled: autoStart)
}

func runAgentTests() {
    print("AgentSupervisor.decideStart() — the one launch prompt")
    check(decide() == .start, "an onboarded user with no agent gets the one prompt")
    check(
        decide(asked: true) == .alreadyAsked,
        "and never a second one in the same session, however many polls fire")
    check(decide(running: true) == .running, "an agent that is up is never prompted for")
    check(
        decide(running: true, asked: true) == .running,
        "a running agent short-circuits before the session flag is even consulted")
    check(
        decide(observed: false) == .waitForObservation,
        "no poll has landed yet, so there is no evidence to prompt on")
    check(
        decide(observed: false, running: true) == .waitForObservation,
        "an unobserved observation is never trusted, whatever it carries")
    check(
        decide(busy: true) == .busy,
        "nothing starts while another privileged run is on screen")
    check(
        decide(autoStart: false) == .disabled,
        "LA_NO_PRIVILEGED / LA_NO_AGENT_AUTOSTART suppress the prompt entirely")

    print("AgentSupervisor.decideStart() — a fresh install belongs to onboarding")
    check(
        decide(hasConfig: false, hasAliases: false) == .deferToOnboarding,
        "no config: onboarding explains what will change before anything happens")
    check(
        decide(hasConfig: true, hasAliases: false) == .deferToOnboarding,
        "a config with no aliases has nothing to apply, so nothing to ask for")
    check(
        decide(hasConfig: false, hasAliases: true) == .deferToOnboarding,
        "aliases without a config file on disk is not an onboarded install")
    check(
        decide(hasConfig: false, autoStart: false) == .deferToOnboarding,
        "the cheap answers come first: an un-onboarded install is not reported as disabled")

    print("AgentSupervisor.route() — mutations must not prompt")
    check(
        AgentSupervisor.route(kind: .apply, agentRunning: true) == .agentReconciles,
        "adding an alias while the agent runs needs no password at all")
    check(
        AgentSupervisor.route(kind: .apply, agentRunning: false) == .needsPrompt,
        "with no agent, an apply is the one prompt that starts it")
    check(
        AgentSupervisor.route(kind: .uninstall, agentRunning: true) == .needsPrompt,
        "uninstall always prompts — root has to undo what root did, and stop the agent")
    check(
        AgentSupervisor.route(kind: .uninstall, agentRunning: false) == .needsPrompt,
        "uninstall prompts even with no agent running")
    check(
        !AgentSupervisor.reconciledMessage.isEmpty
            && AgentSupervisor.reconciledMessage.lowercased().contains("no password"),
        "the no-prompt result explains itself: the dashboard shows this string verbatim")

    print("AgentSupervisor — copy")
    check(
        AgentSupervisor.actionTitle(agentRunning: false).contains("Start"),
        "with no agent the menu offers an explicit way to start it")
    check(
        AgentSupervisor.actionTitle(agentRunning: true) != AgentSupervisor.actionTitle(
            agentRunning: false), "the item does not claim to do the same thing in both states")
    check(
        AgentSupervisor.actionTooltip(agentRunning: false).lowercased().contains("once"),
        "and says the password is asked for once")
    check(
        AgentSupervisor.statusLine(.unobserved).contains("…"),
        "before the first poll the status line says it is still looking")
    check(
        AgentSupervisor.statusLine(.seen(running: false)).lowercased().contains("not running"),
        "a down agent is reported as down, not as a vague warning")
    check(
        AgentSupervisor.statusLine(.seen(running: true)).lowercased().contains("without a prompt"),
        "and a running agent states the benefit the user actually cares about")

    print("AgentProbe — reading the agent's published pid")
    let dir = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("la-agent-tests-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let statusPath = dir.appendingPathComponent("forwarder-status.json").path

    check(!AgentProbe.isRunning(at: statusPath), "no status file means no agent")
    try! "not json".write(toFile: statusPath, atomically: true, encoding: .utf8)
    check(!AgentProbe.isRunning(at: statusPath), "a malformed status file means no agent")
    try! #"{"startedAt":"now"}"#.write(toFile: statusPath, atomically: true, encoding: .utf8)
    check(AgentProbe.pid(at: statusPath) == nil, "a status file without a pid yields no pid")
    try! #"{"pid":0}"#.write(toFile: statusPath, atomically: true, encoding: .utf8)
    check(AgentProbe.pid(at: statusPath) == nil, "pid 0 is not a process")
    try! #"{"pid":-1}"#.write(toFile: statusPath, atomically: true, encoding: .utf8)
    check(AgentProbe.pid(at: statusPath) == nil, "a negative pid is refused, never signalled")

    // Our own pid is the one process this test can be certain about. `kill(pid, 0)` sends
    // nothing — it only asks whether the process exists.
    let mine = getpid()
    try! #"{"pid":\#(mine)}"#.write(toFile: statusPath, atomically: true, encoding: .utf8)
    check(AgentProbe.pid(at: statusPath) == mine, "a real pid is read back exactly")
    check(AgentProbe.isRunning(at: statusPath), "a live pid reads as running")
    // pid 1 is launchd: alive, and owned by root, so it also proves the EPERM branch — the
    // branch that matters, because the real agent runs as root.
    check(AgentProbe.isAlive(pid: 1), "a root-owned pid (EPERM) still counts as alive")
    check(!AgentProbe.isAlive(pid: 0), "pid 0 is never probed")
}
