import Foundation

// =============================================================================================
//  Launch at login (docs/AGENT.md §4).
//
//  The rule this file exists to defend: NEVER an optimistic boolean. `.requiresApproval` means
//  macOS took the registration and left it switched off — the app will not launch, and if the
//  UI shows a happy toggle the feature is silently broken. It must survive all the way from
//  SMAppService to the JSON the dashboard reads.
//
//  It compiles the REAL Sources/LoginItem.swift. LoginItemService.swift — the only file that
//  can call register()/unregister() — is deliberately NOT part of this target, exactly as
//  PrivilegedApply.swift is kept out of it. The reader and the applier are stubs, so this
//  binary cannot touch the real login item.
// =============================================================================================

func runLoginItemTests() {
    print("LoginItemState — the real SMAppService.Status, not a boolean")
    check(LoginItemState.enabled.isOn, "only .enabled counts as on")
    check(
        !LoginItemState.requiresApproval.isOn,
        "REQUIRES APPROVAL IS NOT ON — the app will not launch until the user approves it")
    check(!LoginItemState.notRegistered.isOn, ".notRegistered is off")
    check(!LoginItemState.notFound.isOn, ".notFound is off")
    check(!LoginItemState.unknown.isOn, "an unrecognised status is never reported as on")

    check(
        LoginItemState.requiresApproval.needsSystemSettings,
        "only .requiresApproval sends the user to System Settings")
    for state in [LoginItemState.enabled, .notRegistered, .notFound, .unknown] {
        check(!state.needsSystemSettings, "\(state.rawValue) does not send anyone anywhere")
    }
    check(
        LoginItemState.enabled.isToggleable && LoginItemState.notRegistered.isToggleable
            && LoginItemState.requiresApproval.isToggleable,
        "the toggle works in the three states macOS can actually act on")
    check(
        !LoginItemState.notFound.isToggleable && !LoginItemState.unknown.isToggleable,
        "with no bundle to register, the UI says so instead of offering a switch that fails")

    print("LoginItemState — the copy has to be actionable")
    let approval = LoginItemState.requiresApproval.detail
    check(
        approval.contains("System Settings") && approval.contains("Login Items"),
        "the approval copy names the exact place to go")
    check(
        approval.lowercased().contains("will not start"),
        "and says plainly what happens if the user ignores it")
    check(
        LoginItemState.costWarning.lowercased().contains("once per login"),
        "the cost is stated up front: launching at login means one admin prompt per login")
    for state in [
        LoginItemState.enabled, .requiresApproval, .notRegistered, .notFound, .unknown,
    ] {
        check(
            !state.headline.isEmpty && !state.detail.isEmpty,
            "\(state.rawValue) has a headline and an explanation")
    }

    print("LoginItemWatcher.encodeStatus() — the contract the dashboard reads")
    let json = { (state: LoginItemState, id: String?) -> [String: Any] in
        try! JSONSerialization.jsonObject(
            with: LoginItemWatcher.encodeStatus(state, lastRequestId: id, updatedAt: Date()))
            as! [String: Any]
    }
    let pending = json(.requiresApproval, "r1")
    check(pending["status"] as? String == "requiresApproval", "the raw status is published")
    check(
        pending["enabled"] as? Bool == false,
        "AND `enabled` is false while approval is outstanding — the whole point")
    check(pending["needsSystemSettings"] as? Bool == true, "the UI is told to offer the shortcut")
    check(pending["canToggle"] as? Bool == true, "the toggle still works from this state")
    check((pending["detail"] as? String)?.isEmpty == false, "the explanation travels with it")
    check((pending["warning"] as? String) == LoginItemState.costWarning, "so does the cost")
    check(
        (pending["systemSettingsUrl"] as? String) == LoginItemState.systemSettingsURL,
        "and the deep link, so the dashboard does not hard-code it")
    check(pending["lastRequestId"] as? String == "r1", "the answered request id is published")
    check(json(.enabled, nil)["enabled"] as? Bool == true, "only .enabled publishes enabled=true")
    check(json(.enabled, nil)["lastRequestId"] is NSNull, "no request means an explicit null")
    check(json(.notFound, nil)["canToggle"] as? Bool == false, "and .notFound refuses the toggle")

    print("LoginItemWatcher.decodeRequest()")
    let good = Data(#"{"id":"a","action":"enable","requestedAt":"2026-08-24T10:00:00.000Z"}"#.utf8)
    check(LoginItemWatcher.decodeRequest(good)?.action == .enable, "a well-formed request decodes")
    check(
        LoginItemWatcher.decodeRequest(
            Data(#"{"id":"a","action":"disable","requestedAt":"2026-08-24T10:00:00Z"}"#.utf8))?
            .action == .disable, "a stamp without milliseconds decodes")
    for (label, raw) in [
        ("truncated json", #"{"id":"a","action":"enable""#),
        ("not json", "nope"),
        ("empty", ""),
        ("missing id", #"{"action":"enable","requestedAt":"2026-08-24T10:00:00.000Z"}"#),
        ("empty id", #"{"id":"","action":"enable","requestedAt":"2026-08-24T10:00:00.000Z"}"#),
        ("unknown action", #"{"id":"a","action":"sudo","requestedAt":"2026-08-24T10:00:00.000Z"}"#),
        ("bad stamp", #"{"id":"a","action":"enable","requestedAt":"soon"}"#),
    ] {
        check(
            LoginItemWatcher.decodeRequest(Data(raw.utf8)) == nil,
            "malformed request rejected: \(label)")
    }

    print("LoginItemWatcher.decide()")
    let now = Date()
    let fresh = LoginItemRequest(id: "a", action: .enable, requestedAt: now)
    check(
        LoginItemWatcher.decide(request: fresh, lastHandledId: nil, now: now) == .handle,
        "a fresh request is handled")
    check(
        LoginItemWatcher.decide(request: fresh, lastHandledId: "a", now: now)
            == .ignoreAlreadyHandled, "the same id never registers twice")
    check(
        LoginItemWatcher.decide(request: nil, lastHandledId: nil, now: now) == .ignoreUnreadable,
        "no request, no action")
    check(
        LoginItemWatcher.decide(
            request: LoginItemRequest(
                id: "b", action: .enable,
                requestedAt: now.addingTimeInterval(-(Paths.applyRequestTtl + 1))),
            lastHandledId: nil, now: now) == .ignoreStale,
        "a leftover from a previous session never enables anything by itself")
    check(
        LoginItemWatcher.decide(
            request: LoginItemRequest(
                id: "c", action: .enable,
                requestedAt: now.addingTimeInterval(Paths.applyRequestTtl + 1)),
            lastHandledId: nil, now: now) == .ignoreStale,
        "nor does one stamped in the future")

    // -- the watcher end to end, with a stubbed service ---------------------------------------

    print("LoginItemWatcher — end to end with a stubbed service")
    let dir = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("la-login-tests-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let requestPath = dir.appendingPathComponent("login-item-request.json").path
    let statusPath = dir.appendingPathComponent("login-item.json").path
    let log = Logger(path: dir.appendingPathComponent("tray.log").path)

    func write(id: String, action: String, at date: Date = Date()) {
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        try! #"{"id":"\#(id)","action":"\#(action)","requestedAt":"\#(stamp.string(from: date))"}"#
            .write(toFile: requestPath, atomically: true, encoding: .utf8)
    }
    func published() -> [String: Any] {
        try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: statusPath)))
            as! [String: Any]
    }

    var applied: [LoginItemAction] = []
    // What the stub "SMAppService" reports. Starts off, and — like the real thing — a
    // successful register() lands on .requiresApproval, NOT on .enabled.
    var service: LoginItemState = .notRegistered
    var changes: [LoginItemState] = []

    let watcher = LoginItemWatcher(
        log: log,
        requestPath: requestPath,
        statusPath: statusPath,
        read: { service },
        apply: { action, done in
            applied.append(action)
            switch action {
            case .enable: service = .requiresApproval
            case .disable: service = .notRegistered
            case .refresh: break
            }
            done(service)
        },
        onStateChange: { changes.append($0) })

    watcher.pollOnce()
    check(applied.isEmpty, "no request file, nothing registered")

    write(id: "l1", action: "enable")
    watcher.pollOnce()
    check(applied == [.enable], "an explicit request registers exactly once")
    watcher.pollOnce()
    watcher.pollOnce()
    check(applied == [.enable], "polling again never re-registers")
    check(
        published()["status"] as? String == "requiresApproval",
        "the published status is what the service REPORTS, not what we asked for")
    check(
        published()["enabled"] as? Bool == false,
        "so enabling does not fake an 'on' state that macOS has not granted")
    check(published()["lastRequestId"] as? String == "l1", "the request id is recorded")
    check(
        !FileManager.default.fileExists(atPath: requestPath),
        "the handled request file is removed so it cannot be replayed")

    write(id: "l1", action: "enable")
    watcher.pollOnce()
    check(applied == [.enable], "a re-appearing id is never handled twice")

    write(id: "l-stale", action: "enable", at: Date(timeIntervalSinceNow: -600))
    watcher.pollOnce()
    check(applied == [.enable], "a stale request registers nothing")
    check(!FileManager.default.fileExists(atPath: requestPath), "and is dropped")

    try! "{ not json".write(toFile: requestPath, atomically: true, encoding: .utf8)
    watcher.pollOnce()
    check(applied == [.enable], "a malformed request registers nothing")

    // The user approves in System Settings; nothing in our process changed it.
    service = .enabled
    write(id: "l2", action: "refresh")
    watcher.pollOnce()
    check(applied == [.enable], "refresh never calls the service's register/unregister path")
    check(published()["status"] as? String == "enabled", "but it does republish the real status")
    check(published()["enabled"] as? Bool == true, "which is now genuinely on")
    check(changes.contains(.requiresApproval) && changes.contains(.enabled), "changes are observed")

    write(id: "l3", action: "disable")
    watcher.pollOnce()
    check(applied == [.enable, .disable], "disable is honoured")
    check(published()["status"] as? String == "notRegistered", "and reported truthfully")

    // A relaunch: `lastHandledId` is gone, but login-item.json remembers what was answered.
    var replayed: [LoginItemAction] = []
    func relaunched() -> LoginItemWatcher {
        LoginItemWatcher(
            log: log, requestPath: requestPath, statusPath: statusPath,
            read: { service },
            apply: { action, done in
                replayed.append(action)
                done(service)
            })
    }
    write(id: "l3", action: "disable")
    relaunched().pollOnce()
    check(
        replayed.isEmpty,
        "a request already answered on disk is not replayed after a restart")
    check(!FileManager.default.fileExists(atPath: requestPath), "and the leftover is dropped")
    write(id: "l4", action: "enable")
    relaunched().pollOnce()
    check(replayed == [.enable], "a genuinely new request after a restart still works")
}
