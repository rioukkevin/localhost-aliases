import Foundation

// =============================================================================================
//  The shutdown hang, reproduced and fixed.
//
//  The real bug on this machine: SIGTERM logged "shutting down", stopped the heartbeat and the
//  dashboard, and then sat in -[NSApplication run] forever, needing SIGKILL.
//
//  `applicationShouldTerminate` returns `.terminateLater` — a promise that somebody will call
//  `NSApp.reply(toApplicationShouldTerminate:)`. AppKit only honours that reply after the
//  delegate method has RETURNED. Two ways the promise broke:
//
//    A. `DashboardProcess.stop`'s early-return guard (already stopped / never started) called
//       its completion synchronously, so the reply ran while `applicationShouldTerminate` was
//       still on the stack and AppKit dropped it.
//    B. A child that never reports leaves the reply unsent with nothing watching.
//
//  There is no NSApplication here. `reply` and `hardExit` are counters and the clock is a
//  manual scheduler, so both failures are ordinary assertions rather than a hung test run.
// =============================================================================================

/// Drives TerminationCoordinator's timers by hand. Nothing fires until the test says so.
private final class ManualScheduler {
    private(set) var jobs: [(delay: TimeInterval, body: () -> Void)] = []

    func schedule(_ delay: TimeInterval, _ body: @escaping () -> Void) {
        jobs.append((delay, body))
    }

    /// Runs everything due at or before `time`, once.
    func advance(to time: TimeInterval) {
        let due = jobs.filter { $0.delay <= time }
        jobs.removeAll { $0.delay <= time }
        for job in due { job.body() }
    }
}

/// Stands in for `DispatchQueue.main.async`: blocks are held until `drain()`, which is exactly
/// what "a later turn of the main run loop" means.
private final class ManualMainQueue {
    private var blocks: [() -> Void] = []

    func async(_ body: @escaping () -> Void) { blocks.append(body) }

    func drain() {
        let pending = blocks
        blocks.removeAll()
        for block in pending { block() }
    }

    var isEmpty: Bool { blocks.isEmpty }
}

private struct Harness {
    let coordinator: TerminationCoordinator
    let scheduler: ManualScheduler
    let mainQueue: ManualMainQueue
    /// Recorded in call order, so ORDERING can be asserted, not just counts.
    let events: () -> [String]
}

private func makeHarness(replyDeadline: TimeInterval = 6, exitDeadline: TimeInterval = 10)
    -> Harness
{
    let scheduler = ManualScheduler()
    let mainQueue = ManualMainQueue()
    var events: [String] = []
    let coordinator = TerminationCoordinator(
        replyDeadline: replyDeadline,
        exitDeadline: exitDeadline,
        log: { _ in },
        schedule: { delay, body in scheduler.schedule(delay, body) },
        deferToMain: { body in mainQueue.async(body) },
        reply: { events.append("reply") },
        hardExit: { events.append("exit") })
    return Harness(
        coordinator: coordinator, scheduler: scheduler, mainQueue: mainQueue,
        events: { events })
}

func runTerminationTests() {
    print("TerminationCoordinator — the happy path")
    do {
        let h = makeHarness()
        h.coordinator.begin(waitingFor: ["dashboard"])
        check(h.events().isEmpty, "begin() alone never replies")
        h.coordinator.finished("dashboard")
        // This is bug A in miniature: the child reported while applicationShouldTerminate was
        // still on the stack. The reply must NOT have gone out yet.
        check(
            h.events().isEmpty,
            "a child reporting before applicationShouldTerminate returns does not reply yet")
        h.mainQueue.drain()  // applicationShouldTerminate has now returned
        check(h.events() == ["reply"], "the reply goes out once the delegate method has returned")
        check(h.coordinator.replyCount == 1, "exactly one reply")
    }

    print("TerminationCoordinator — the latent synchronous bug (dashboard already stopped)")
    do {
        // DashboardProcess.stop's early-return guard used to call its completion inline. Even
        // if a future caller reintroduces that, the reply still cannot outrun the return.
        let h = makeHarness()
        var replyBeforeReturn = false
        h.coordinator.begin(waitingFor: ["dashboard"])
        h.coordinator.finished("dashboard")  // inline, as the old guard did
        replyBeforeReturn = !h.events().isEmpty
        check(!replyBeforeReturn, "an inline completion cannot deliver the reply early")
        h.mainQueue.drain()
        check(h.events() == ["reply"], "and the reply is still delivered, exactly once")
    }

    print("TerminationCoordinator — nothing to wait for")
    do {
        let h = makeHarness()
        h.coordinator.begin(waitingFor: [])
        check(h.events().isEmpty, "an empty wait list still does not reply inline")
        h.mainQueue.drain()
        check(h.events() == ["reply"], "an empty wait list replies on the next run-loop turn")
    }

    print("TerminationCoordinator — exactly once")
    do {
        let h = makeHarness()
        h.coordinator.begin(waitingFor: ["dashboard"])
        h.mainQueue.drain()
        h.coordinator.finished("dashboard")
        h.coordinator.finished("dashboard")
        h.coordinator.finished("dashboard")
        check(h.coordinator.replyCount == 1, "a child reporting three times replies once")
        h.coordinator.finished("something-nobody-waited-for")
        check(h.coordinator.replyCount == 1, "an unknown name changes nothing")
        h.scheduler.advance(to: 6)
        check(h.coordinator.replyCount == 1, "the watchdog does not add a second reply")
    }

    print("TerminationCoordinator — two children")
    do {
        let h = makeHarness()
        h.coordinator.begin(waitingFor: ["dashboard", "agent"])
        h.mainQueue.drain()
        h.coordinator.finished("dashboard")
        check(h.events().isEmpty, "one of two children is not enough")
        h.coordinator.finished("agent")
        check(h.events() == ["reply"], "the reply waits for the last child")
    }

    print("TerminationCoordinator — the child that never reports (bug B)")
    do {
        let h = makeHarness(replyDeadline: 6, exitDeadline: 10)
        h.coordinator.begin(waitingFor: ["dashboard"])
        h.mainQueue.drain()
        h.scheduler.advance(to: 5.9)
        check(h.events().isEmpty, "before the deadline the coordinator waits")
        h.scheduler.advance(to: 6)
        check(h.events() == ["reply"], "the watchdog replies without the silent child")
        check(h.coordinator.replyCount == 1, "still exactly one reply")
        h.coordinator.finished("dashboard")  // it finally wakes up
        check(h.coordinator.replyCount == 1, "a late child does not reply a second time")
    }

    print("TerminationCoordinator — AppKit ignores the reply anyway")
    do {
        // The observed hang: the reply went out and the app STILL sat in -[NSApplication run].
        // Being polite has a deadline too, because a wedged tray blocks `make install`.
        let h = makeHarness(replyDeadline: 6, exitDeadline: 10)
        h.coordinator.begin(waitingFor: ["dashboard"])
        h.mainQueue.drain()
        h.coordinator.finished("dashboard")
        check(h.events() == ["reply"], "the reply is delivered")
        h.scheduler.advance(to: 9.9)
        check(h.events() == ["reply"], "the exit watchdog has not fired yet")
        h.scheduler.advance(to: 10)
        check(h.events() == ["reply", "exit"], "still alive at the deadline -> hard exit")
        check(h.coordinator.hardExitCount == 1, "exactly one hard exit")
    }

    print("TerminationCoordinator — the deadlines are ordered")
    do {
        // The dashboard escalates SIGTERM to SIGKILL after 5s, so it reports by ~5.1s. Reply
        // at 6s therefore only fires for a genuinely stuck child, and the hard exit last.
        check(
            TerminationCoordinator.defaultReplyDeadline > 5,
            "the reply watchdog outlasts DashboardProcess's own 5s SIGKILL escalation")
        check(
            TerminationCoordinator.defaultExitDeadline
                > TerminationCoordinator.defaultReplyDeadline,
            "the hard exit is always the last resort, never the first")
    }

    print("TerminationCoordinator — a second Quit")
    do {
        let h = makeHarness()
        h.coordinator.begin(waitingFor: ["dashboard"])
        h.coordinator.begin(waitingFor: ["dashboard", "agent"])  // second SIGTERM / second Quit
        h.mainQueue.drain()
        h.coordinator.finished("dashboard")
        check(h.coordinator.replyCount == 1, "a second begin() does not re-arm the wait list")
        check(h.scheduler.jobs.count == 2, "and does not stack a second pair of watchdogs")
    }

    print("TerminationCoordinator — nothing happens before begin()")
    do {
        let h = makeHarness()
        h.coordinator.finished("dashboard")
        h.mainQueue.drain()
        h.scheduler.advance(to: 60)
        check(
            h.events().isEmpty && h.coordinator.replyCount == 0,
            "no reply and no exit without a shutdown in progress")
    }
}
