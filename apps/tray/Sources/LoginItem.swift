import Foundation

// =============================================================================================
//  Launch at login (docs/AGENT.md §4) — the honest half.
//
//  Only the menu-bar app can talk to SMAppService, and only a Swift process can read its real
//  status. The settings drawer lives in the dashboard, which is a web page. So the same shape
//  the privileged channel already uses applies here:
//
//    login-item.json          written by the TRAY   — the real, current SMAppService.Status
//    login-item-request.json  written by the DASHBOARD — { id, action, requestedAt }
//
//  Two plain files in the user's own config dir. No port, no URL scheme, nothing to
//  authenticate — and nothing to install.
//
//  NOTHING IN THIS FILE CALLS SMAppService. Reading the status and registering are injected
//  (LoginItemService is the only implementation, and the only file that can call register()),
//  so apps/tray/tests exercise every decision below without ever touching the real login item.
// =============================================================================================

/// Every `SMAppService.Status` this app can see, plus the case where the framework answers
/// something we have never heard of. Never an optimistic boolean: `.requiresApproval` and
/// `.enabled` are BOTH "the user said yes", and only one of them actually launches the app.
enum LoginItemState: String, Equatable {
    /// `.enabled` — registered and approved. This is the only state that launches the app.
    case enabled
    /// `.requiresApproval` — macOS accepted the registration but the user must switch it on in
    /// System Settings. Reporting this as "on" is exactly how a feature looks silently broken.
    case requiresApproval
    /// `.notRegistered` — off, and nothing is pending.
    case notRegistered
    /// `.notFound` — macOS cannot find the app as a login item. In practice: the binary is not
    /// running from inside an .app bundle (a dev build), or the bundle has been moved.
    case notFound
    /// A status this build does not know. Report the raw value rather than guessing.
    case unknown

    /// Registered AND approved. Nothing else is on.
    var isOn: Bool { self == .enabled }

    /// True when the user has to leave the app to finish the job.
    var needsSystemSettings: Bool { self == .requiresApproval }

    /// Whether the toggle can do anything at all. `.notFound` means there is no bundle to
    /// register, so a toggle would fail every time; the UI should say so instead of trying.
    var isToggleable: Bool { self != .notFound && self != .unknown }

    /// Short label. Plain language, present tense, no jargon.
    var headline: String {
        switch self {
        case .enabled: return "On — opens when you log in"
        case .requiresApproval: return "Waiting for your approval"
        case .notRegistered: return "Off"
        case .notFound: return "Unavailable in this build"
        case .unknown: return "Unknown"
        }
    }

    /// The sentence that has to make the state actionable. `.requiresApproval` is the one that
    /// matters: without this line the switch reads as on and nothing happens at the next login.
    var detail: String {
        switch self {
        case .enabled:
            return "Localhost Aliases starts automatically when you log in."
        case .requiresApproval:
            return
                "macOS has the request but it is switched off. Open System Settings › General › "
                + "Login Items & Extensions, find Localhost Aliases under \"Open at Login\", and "
                + "turn it on. Until you do, the app will not start by itself."
        case .notRegistered:
            return "Localhost Aliases does not start on its own. Open it yourself when you need it."
        case .notFound:
            return
                "macOS cannot find Localhost Aliases as a login item. This is normal when the app "
                + "is run from a development build rather than from /Applications."
        case .unknown:
            return "macOS reported a status this version does not recognise. Nothing was changed."
        }
    }

    /// Said BEFORE the user enables it, never after. Launching at login under the root-agent
    /// model means the one admin prompt happens at every login — a real cost, and a user who
    /// dislikes it deserves to know in advance (docs/AGENT.md §4).
    static let costWarning =
        "Starting at login means the administrator prompt appears once per login, "
        + "because the root agent has to be started again after every restart."

    /// macOS 13+ moved login items here. Opening System Settings needs no privileges.
    static let systemSettingsURL =
        "x-apple.systempreferences:com.apple.LoginItems-Settings.extension"
}

/// What the dashboard may ask for.
enum LoginItemAction: String, Equatable {
    case enable
    case disable
    /// Re-read the status and rewrite the file. Never registers anything.
    case refresh
}

/// A decoded login-item-request.json. Anything malformed simply never produces one.
struct LoginItemRequest: Equatable {
    let id: String
    let action: LoginItemAction
    let requestedAt: Date
}

/// Why a poll did or did not act. Same vocabulary as ApplyRequestDecision on purpose — one
/// channel shape, learned once.
enum LoginItemDecision: Equatable {
    case ignoreUnreadable
    case ignoreAlreadyHandled
    case ignoreStale
    case handle
}

/// Polls the request file, applies the action through an injected service, and republishes the
/// real status. Never trusts what it just asked for: the file it writes always reports what
/// SMAppService says afterwards.
final class LoginItemWatcher {
    /// Reads the live status. Cheap and side-effect free.
    typealias Reader = () -> LoginItemState
    /// Performs an enable/disable and calls back on the main thread with the resulting status.
    /// `refresh` never reaches it.
    typealias Applier = (LoginItemAction, @escaping (LoginItemState) -> Void) -> Void

    private let log: Logger
    private let requestPath: String
    private let statusPath: String
    private let interval: TimeInterval
    private let read: Reader
    private let apply: Applier
    private let onStateChange: (LoginItemState) -> Void

    private var timer: Timer?
    private var lastHandledId: String?
    private var running = false
    private(set) var state: LoginItemState = .unknown

    init(
        log: Logger,
        requestPath: String = Paths.loginItemRequestPath,
        statusPath: String = Paths.loginItemStatusPath,
        interval: TimeInterval = Paths.applyPollInterval,
        read: @escaping Reader,
        apply: @escaping Applier,
        onStateChange: @escaping (LoginItemState) -> Void = { _ in }
    ) {
        self.log = log
        self.requestPath = requestPath
        self.statusPath = statusPath
        self.interval = interval
        self.read = read
        self.apply = apply
        self.onStateChange = onStateChange
    }

    // MARK: - Lifecycle

    func start() {
        stop()
        publish(read(), lastRequestId: nil)
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            self?.pollOnce()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        pollOnce()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// One poll: a stat plus a small read. The harness calls it directly, which is why it does
    /// no threading of its own.
    func pollOnce() {
        let data = FileManager.default.contents(atPath: requestPath)
        let request = data.flatMap(Self.decodeRequest)
        let answered = lastHandledId ?? Self.publishedRequestId(at: statusPath)
        let decision = Self.decide(request: request, lastHandledId: answered, now: Date())

        switch decision {
        case .ignoreUnreadable:
            return
        case .ignoreAlreadyHandled:
            if let request { clearRequest(id: request.id) }
            return
        case .ignoreStale:
            guard let request else { return }
            lastHandledId = request.id
            log.log("login-item: ignoring stale request \(request.id) (\(request.action.rawValue))")
            clearRequest(id: request.id)
        case .handle:
            guard let request, !running else { return }
            handle(request)
        }
    }

    private func handle(_ request: LoginItemRequest) {
        lastHandledId = request.id
        log.log("login-item: handling \(request.action.rawValue) request \(request.id)")

        guard request.action != .refresh else {
            publish(read(), lastRequestId: request.id)
            clearRequest(id: request.id)
            return
        }

        running = true
        // THE ONLY PATH TO register()/unregister(). It is reached only from `.handle`, which
        // needs a fresh, never-seen request id written by an explicit click in the dashboard.
        apply(request.action) { [weak self] state in
            guard let self else { return }
            self.running = false
            self.publish(state, lastRequestId: request.id)
            self.clearRequest(id: request.id)
        }
    }

    /// Rewrites the status file. Always the state the service actually reports — including
    /// after a failed register(), where the honest answer is still `.notRegistered`.
    private func publish(_ state: LoginItemState, lastRequestId: String?) {
        let changed = state != self.state
        self.state = state
        let data = Self.encodeStatus(state, lastRequestId: lastRequestId, updatedAt: Date())
        let written = ApplyRequestWatcher.writeResult(data, to: statusPath)
        if changed || lastRequestId != nil {
            log.log("login-item: status=\(state.rawValue) written=\(written)")
        }
        if changed { onStateChange(state) }
    }

    private func clearRequest(id: String) {
        guard let data = FileManager.default.contents(atPath: requestPath),
            let current = Self.decodeRequest(data), current.id == id
        else { return }
        try? FileManager.default.removeItem(atPath: requestPath)
    }

    // MARK: - Pure logic (this is what the harness exercises)

    /// No `isBusy` here: a login-item toggle cannot raise a dialog, so the only rules are
    /// "never twice" and "never a leftover".
    static func decide(request: LoginItemRequest?, lastHandledId: String?, now: Date)
        -> LoginItemDecision
    {
        guard let request else { return .ignoreUnreadable }
        if let lastHandledId, request.id == lastHandledId { return .ignoreAlreadyHandled }
        if abs(now.timeIntervalSince(request.requestedAt)) > Paths.applyRequestTtl {
            return .ignoreStale
        }
        return .handle
    }

    static func decodeRequest(_ data: Data) -> LoginItemRequest? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let id = object["id"] as? String, !id.isEmpty,
            let raw = object["action"] as? String,
            let action = LoginItemAction(rawValue: raw),
            let stamp = object["requestedAt"] as? String,
            let requestedAt = ApplyRequestWatcher.parseTimestamp(stamp)
        else { return nil }
        return LoginItemRequest(id: id, action: action, requestedAt: requestedAt)
    }

    /// The request id the last published status answered — the durable stand-in for
    /// `lastHandledId` across a relaunch, exactly as apply-result.json is for the other channel.
    static func publishedRequestId(at path: String) -> String? {
        guard let data = FileManager.default.contents(atPath: path),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let id = object["lastRequestId"] as? String, !id.isEmpty
        else { return nil }
        return id
    }

    /// The whole contract the dashboard reads. Every field is derived from the real status;
    /// `enabled` is deliberately false while approval is outstanding.
    static func encodeStatus(_ state: LoginItemState, lastRequestId: String?, updatedAt: Date)
        -> Data
    {
        let object: [String: Any] = [
            "status": state.rawValue,
            "enabled": state.isOn,
            "canToggle": state.isToggleable,
            "needsSystemSettings": state.needsSystemSettings,
            "headline": state.headline,
            "detail": state.detail,
            "warning": LoginItemState.costWarning,
            "systemSettingsUrl": LoginItemState.systemSettingsURL,
            "lastRequestId": lastRequestId ?? NSNull(),
            "updatedAt": ISO8601DateFormatter().string(from: updatedAt),
        ]
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
            ?? Data("{}".utf8)
    }
}
