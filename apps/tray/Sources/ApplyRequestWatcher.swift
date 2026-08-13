import Darwin
import Foundation

// =============================================================================================
//  The dashboard -> tray request channel.
//
//  A web page cannot raise a macOS admin prompt, so by design the dashboard never runs a
//  privileged command: its "Prepare and apply" button writes a REQUEST file, this watcher picks
//  it up, runs the privileged batch through the SAME path the menu uses (PrivilegedApply, one
//  `with administrator privileges` dialog), and writes a RESULT file back for the dashboard.
//
//  The frozen contract lives in packages/core/src/paths.ts + types.ts:
//    apply-request.json  { id, kind: "apply" | "uninstall", requestedAt }
//    apply-result.json   { id, kind, ok, cancelled, error, startedAt, finishedAt }
//    APPLY_POLL_MS = 1000, APPLY_REQUEST_TTL_MS = 90000
//
//  NOTHING IN THIS FILE CALLS osascript. The privileged work is injected as `run`, so every
//  decision below can be compiled and exercised (apps/tray/tests) with zero chance of a
//  password dialog. The only real runner is wired in AppDelegate.
// =============================================================================================

/// Mirrors `PrivilegedKind` in packages/core/src/types.ts.
enum PrivilegedRequestKind: String {
    case apply
    case uninstall
}

/// A decoded apply-request.json. Absent/short/malformed files never produce one.
struct PrivilegedRequestRecord: Equatable {
    let id: String
    let kind: PrivilegedRequestKind
    let requestedAt: Date
}

/// What the injected runner reports back. Deliberately not `PrivilegedApply.Result` so this
/// file — and its tests — never have to link the code that owns the prompt.
struct PrivilegedRunOutcome {
    let ok: Bool
    /// True when the user dismissed the macOS password dialog. Not an error.
    let cancelled: Bool
    /// Raw script output; only surfaced when `ok` is false.
    let output: String
}

/// Why a poll did or did not act. Every case is reachable from `decide`, which is pure.
enum ApplyRequestDecision: Equatable {
    /// No file, or a file that is not a request we understand. Silence is the correct answer.
    case ignoreUnreadable
    /// Same id we already ran (or already refused). A second prompt for one click is a bug.
    case ignoreAlreadyHandled
    /// Older than APPLY_REQUEST_TTL_MS — typically a leftover from a previous session.
    /// Replaying it would raise a password dialog nobody asked for.
    case ignoreStale
    /// A privileged operation is already on screen. Try again on the next tick.
    case ignoreBusy
    case handle
}

final class ApplyRequestWatcher {
    /// Runs the privileged batch and calls back on the main thread. Injected so the watcher
    /// can be tested without the prompt; AppDelegate passes the real PrivilegedApply path.
    typealias Runner = (PrivilegedRequestKind, @escaping (PrivilegedRunOutcome) -> Void) -> Void

    private let log: Logger
    private let requestPath: String
    private let resultPath: String
    private let interval: TimeInterval
    /// True while any privileged operation is running — including one started from the menu,
    /// which this watcher must never double up on.
    private let isBusy: () -> Bool
    private let run: Runner

    private var timer: Timer?
    /// Every id this watcher has already acted on OR deliberately refused. One entry is enough:
    /// requests are handled in order and an id is a fresh UUID per click.
    private var lastHandledId: String?
    /// This watcher's own in-flight run. Belt and braces next to `isBusy()`.
    private var running = false
    /// Log-once bookkeeping so a request that waits for a busy prompt does not spam the log.
    private var lastLoggedBusyId: String?

    init(
        log: Logger,
        requestPath: String = Paths.applyRequestPath,
        resultPath: String = Paths.applyResultPath,
        interval: TimeInterval = Paths.applyPollInterval,
        isBusy: @escaping () -> Bool,
        run: @escaping Runner
    ) {
        self.log = log
        self.requestPath = requestPath
        self.resultPath = resultPath
        self.interval = interval
        self.isBusy = isBusy
        self.run = run
    }

    // MARK: - Lifecycle

    func start() {
        stop()
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            self?.pollOnce()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        log.log("apply-watcher: polling \(requestPath) every \(interval)s")
        pollOnce()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    // MARK: - Polling

    /// One synchronous poll: a stat plus a small read. `start()` runs it on a timer; the test
    /// harness calls it directly, which is why it does no threading of its own.
    func pollOnce() {
        let data = FileManager.default.contents(atPath: requestPath)
        let request = data.flatMap(Self.decodeRequest)
        // `lastHandledId` dies with the process. If we crashed (or were quit) between writing
        // the result and deleting the request, a relaunch inside the TTL would otherwise replay
        // it — a second password prompt for one click. The result file is the durable record of
        // what has already been answered, so it stands in when memory is empty.
        let answered = lastHandledId ?? Self.completedId(at: resultPath)
        let decision = Self.decide(
            request: request,
            lastHandledId: answered,
            isBusy: running || isBusy(),
            now: Date())

        switch decision {
        case .ignoreUnreadable:
            return
        case .ignoreAlreadyHandled:
            // Only the crash case above can leave the file behind — in-process, `finish` has
            // already removed it. Drop it so a later, unrelated result cannot make this
            // leftover look like a request nobody answered.
            if lastHandledId == nil, let request { clearRequest(id: request.id) }
            return
        case .ignoreStale:
            guard let request else { return }
            // Refused for good: remember the id so the next tick does not re-evaluate it, and
            // drop the file so it cannot be replayed after a clock change or a restart.
            lastHandledId = request.id
            log.log("apply-watcher: ignoring stale request \(request.id) (\(request.kind.rawValue))")
            clearRequest(id: request.id)
        case .ignoreBusy:
            guard let request, lastLoggedBusyId != request.id else { return }
            lastLoggedBusyId = request.id
            log.log("apply-watcher: request \(request.id) waiting — a privileged run is in flight")
        case .handle:
            guard let request else { return }
            handle(request)
        }
    }

    /// The ONE call site that can lead to an admin prompt from this file, and it is reached
    /// only through `.handle`. `lastHandledId` is set BEFORE the run starts, so a tick that
    /// fires while the dialog is on screen can never start a second one.
    private func handle(_ request: PrivilegedRequestRecord) {
        lastHandledId = request.id
        running = true
        let startedAt = Date()
        log.log("apply-watcher: handling \(request.kind.rawValue) request \(request.id)")

        run(request.kind) { [weak self] outcome in
            guard let self else { return }
            self.running = false
            self.finish(request: request, outcome: outcome, startedAt: startedAt)
        }
    }

    /// A result is written for every run — success, cancellation and failure alike. A missing
    /// result is the one outcome the dashboard cannot recover from: it just spins.
    private func finish(
        request: PrivilegedRequestRecord, outcome: PrivilegedRunOutcome, startedAt: Date
    ) {
        let data = Self.encodeResult(
            id: request.id,
            kind: request.kind,
            ok: outcome.ok,
            cancelled: outcome.cancelled,
            error: outcome.ok ? nil : Self.errorMessage(from: outcome.output, cancelled: outcome.cancelled),
            startedAt: startedAt,
            finishedAt: Date())

        let written = Self.writeResult(data, to: resultPath)
        log.log(
            "apply-watcher: result \(request.id) ok=\(outcome.ok) cancelled=\(outcome.cancelled) written=\(written)"
        )
        clearRequest(id: request.id)
    }

    /// Removes the request file, but only while it still holds the id we handled — a newer
    /// click may have superseded it while the prompt was on screen, and that one must survive.
    private func clearRequest(id: String) {
        guard let data = FileManager.default.contents(atPath: requestPath),
            let current = Self.decodeRequest(data), current.id == id
        else { return }
        try? FileManager.default.removeItem(atPath: requestPath)
    }

    // MARK: - Pure logic (this is what the harness exercises)

    /// The whole de-duplication and staleness rule, with no I/O in sight.
    static func decide(
        request: PrivilegedRequestRecord?, lastHandledId: String?, isBusy: Bool, now: Date
    ) -> ApplyRequestDecision {
        guard let request else { return .ignoreUnreadable }
        if let lastHandledId, request.id == lastHandledId { return .ignoreAlreadyHandled }
        // `abs` also rejects a request stamped far in the future: a clock that disagrees by
        // more than the TTL is not evidence that a user just clicked.
        if abs(now.timeIntervalSince(request.requestedAt)) > Paths.applyRequestTtl {
            return .ignoreStale
        }
        if isBusy { return .ignoreBusy }
        return .handle
    }

    /// The signature the review asks for: true only when this request must be run now.
    static func shouldHandle(
        request: PrivilegedRequestRecord?, lastHandledId: String?, now: Date
    ) -> Bool {
        decide(request: request, lastHandledId: lastHandledId, isBusy: false, now: now) == .handle
    }

    /// The id of the last result on disk, or nil when there is none. Read rather than cached:
    /// the point is to survive a restart, which a cache by definition does not.
    static func completedId(at path: String) -> String? {
        guard let data = FileManager.default.contents(atPath: path),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let id = object["id"] as? String, !id.isEmpty
        else { return nil }
        return id
    }

    /// Tolerant by omission: anything that is not a complete, understood request is nil, and
    /// nil means "do nothing". A half-written file the dashboard is still flushing lands here.
    static func decodeRequest(_ data: Data) -> PrivilegedRequestRecord? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let id = object["id"] as? String, !id.isEmpty,
            let rawKind = object["kind"] as? String,
            let kind = PrivilegedRequestKind(rawValue: rawKind),
            let rawDate = object["requestedAt"] as? String,
            let requestedAt = parseTimestamp(rawDate)
        else { return nil }
        return PrivilegedRequestRecord(id: id, kind: kind, requestedAt: requestedAt)
    }

    /// `new Date().toISOString()` carries milliseconds; hand-written stamps often do not.
    static func parseTimestamp(_ value: String) -> Date? {
        fractionalFormatter.date(from: value) ?? plainFormatter.date(from: value)
    }

    private static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plainFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// Exactly the `PrivilegedResult` shape from packages/core/src/types.ts. `error` is an
    /// explicit null rather than a missing key so the dashboard never has to guess.
    static func encodeResult(
        id: String,
        kind: PrivilegedRequestKind,
        ok: Bool,
        cancelled: Bool,
        error: String?,
        startedAt: Date,
        finishedAt: Date
    ) -> Data {
        let object: [String: Any] = [
            "id": id,
            "kind": kind.rawValue,
            "ok": ok,
            "cancelled": cancelled,
            "error": error ?? NSNull(),
            "startedAt": fractionalFormatter.string(from: startedAt),
            "finishedAt": fractionalFormatter.string(from: finishedAt),
        ]
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
            ?? Data("{}".utf8)
    }

    /// Script output is unbounded and can carry a stack trace; the dashboard shows one line.
    static func errorMessage(from output: String, cancelled: Bool) -> String {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return cancelled ? "Cancelled at the password prompt" : "The privileged step failed"
        }
        guard trimmed.count > 2000 else { return trimmed }
        return String(trimmed.suffix(2000))
    }

    /// Temp file in the SAME directory, then rename(2): atomic on the volume, and it replaces
    /// an existing result. A reader therefore sees the previous result or the new one, never
    /// a half-written JSON.
    @discardableResult
    static func writeResult(_ data: Data, to path: String) -> Bool {
        let directory = (path as NSString).deletingLastPathComponent
        Paths.ensureDirectory(directory)
        let temp = "\(path).\(UUID().uuidString).tmp"
        guard (try? data.write(to: URL(fileURLWithPath: temp))) != nil else { return false }
        guard rename(temp, path) == 0 else {
            try? FileManager.default.removeItem(atPath: temp)
            return false
        }
        return true
    }
}
