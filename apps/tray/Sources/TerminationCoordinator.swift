import Foundation

// =============================================================================================
//  Why this file exists: the app used to hang on quit.
//
//  `applicationShouldTerminate` returns `.terminateLater`, which is a promise that somebody
//  will later call `NSApp.reply(toApplicationShouldTerminate:)`. AppKit only honours that reply
//  AFTER the delegate method has returned. Two ways that promise was broken:
//
//    1. `DashboardProcess.stop`'s early-return guard (dashboard already stopped, or never
//       started) called its completion SYNCHRONOUSLY. The reply therefore ran while
//       `applicationShouldTerminate` was still on the stack, AppKit discarded it, and the app
//       sat in `-[NSApplication run]` forever needing SIGKILL.
//    2. A child that never reports at all — a wedged `bun` that ignores SIGTERM, a completion
//       dropped on the floor — leaves the reply unsent with nothing to notice.
//
//  A wedged tray is not cosmetic: `make install` refuses to replace a running app, so it also
//  blocks reinstalling.
//
//  The coordinator makes the reply an invariant instead of a hope:
//    * it is never delivered before `arm()`, and `arm()` is scheduled to run only once the
//      current main-thread callout (i.e. `applicationShouldTerminate`) has returned;
//    * it is delivered at most once, however many children report, twice or not at all;
//    * a watchdog delivers it anyway if a child goes silent;
//    * a second, later watchdog calls `exit(0)` if AppKit still will not tear the process down.
//
//  Nothing here imports AppKit. `reply` and `hardExit` are injected, which is what lets
//  apps/tray/tests drive every path — including the two above — without an NSApplication.
// =============================================================================================

/// Delivers the AppKit termination reply exactly once, on every path.
final class TerminationCoordinator {
    /// Runs `body` after `delay` seconds. Defaults to a main run-loop timer.
    typealias Schedule = (_ delay: TimeInterval, _ body: @escaping () -> Void) -> Void
    /// Runs `body` on a later turn of the main run loop — never inline.
    typealias Defer = (_ body: @escaping () -> Void) -> Void

    /// How long a child may take to report before the reply goes out without it.
    /// Longer than DashboardProcess's own 5s SIGTERM→SIGKILL escalation, so the normal
    /// slow path still reports for itself.
    static let defaultReplyDeadline: TimeInterval = 6
    /// How long the whole process may take to disappear before we stop being polite.
    static let defaultExitDeadline: TimeInterval = 10

    private let reply: () -> Void
    private let hardExit: () -> Void
    private let schedule: Schedule
    private let deferToMain: Defer
    private let replyDeadline: TimeInterval
    private let exitDeadline: TimeInterval
    private let log: (String) -> Void

    private var started = false
    private var armed = false
    private var pending: Set<String> = []
    /// Counted rather than flagged so a test can prove "exactly once", not merely "at least once".
    private(set) var replyCount = 0
    private(set) var hardExitCount = 0

    init(
        replyDeadline: TimeInterval = TerminationCoordinator.defaultReplyDeadline,
        exitDeadline: TimeInterval = TerminationCoordinator.defaultExitDeadline,
        log: @escaping (String) -> Void = { _ in },
        schedule: @escaping Schedule = TerminationCoordinator.mainRunLoopSchedule,
        deferToMain: @escaping Defer = { body in DispatchQueue.main.async(execute: body) },
        reply: @escaping () -> Void,
        hardExit: @escaping () -> Void
    ) {
        self.replyDeadline = replyDeadline
        self.exitDeadline = exitDeadline
        self.log = log
        self.schedule = schedule
        self.deferToMain = deferToMain
        self.reply = reply
        self.hardExit = hardExit
    }

    /// Call from `applicationShouldTerminate`, BEFORE returning `.terminateLater`.
    ///
    /// `names` are the children whose shutdown the reply waits on. An empty list is legal and
    /// means "reply as soon as it is safe to" — which is still not inline, because arming is
    /// deferred to a later run-loop turn.
    ///
    /// Calling it twice is a no-op: the second Quit is answered by the delegate's own
    /// `.terminateNow` guard, and must not restart the watchdogs.
    func begin(waitingFor names: [String]) {
        guard !started else {
            log("terminate: begin ignored — already shutting down")
            return
        }
        started = true
        pending = Set(names)

        schedule(replyDeadline) { [weak self] in self?.replyWatchdogFired() }
        schedule(exitDeadline) { [weak self] in self?.exitWatchdogFired() }

        // THE ORDERING FIX. Arming happens on a later turn of the main run loop, so even a
        // child that completes synchronously inside `begin`'s caller cannot make the reply
        // land before `applicationShouldTerminate` has returned `.terminateLater`.
        deferToMain { [weak self] in self?.arm() }
    }

    /// A child finished shutting down. Idempotent, and safe for a name that was never awaited.
    func finished(_ name: String) {
        guard started else { return }
        if pending.remove(name) != nil {
            log("terminate: \(name) stopped; still waiting on \(describePending())")
        }
        flush()
    }

    /// `applicationShouldTerminate` has returned by now; the reply may be delivered.
    private func arm() {
        guard started, !armed else { return }
        armed = true
        flush()
    }

    private func flush() {
        guard started, armed, pending.isEmpty, replyCount == 0 else { return }
        replyCount += 1
        log("terminate: replying to AppKit — every child has stopped")
        reply()
    }

    private func replyWatchdogFired() {
        guard started, replyCount == 0 else { return }
        log(
            "terminate: watchdog after \(Int(replyDeadline))s — \(describePending()) never reported; "
                + "replying anyway")
        pending.removeAll()
        // The watchdog can outrun `arm()` only if the main queue never drained, in which case
        // this block would not be running either. Arm defensively so the reply cannot be lost.
        armed = true
        flush()
    }

    private func exitWatchdogFired() {
        guard started else { return }
        hardExitCount += 1
        log(
            "terminate: still alive \(Int(exitDeadline))s after shutdown began — exiting the hard way")
        hardExit()
    }

    private func describePending() -> String {
        pending.isEmpty ? "nothing" : pending.sorted().joined(separator: ", ")
    }

    /// `.common` so a tracking run-loop mode (an open menu) cannot stall the watchdogs.
    static func mainRunLoopSchedule(_ delay: TimeInterval, _ body: @escaping () -> Void) {
        let timer = Timer(timeInterval: delay, repeats: false) { _ in body() }
        RunLoop.main.add(timer, forMode: .common)
    }
}
