import Foundation

/// Supervises `packages/web` (the Next.js dashboard + REST API) as a child of the tray.
///
/// Policy only — spawning, signalling and reaping live in `ChildProcess`. Restarts an
/// unexpected exit with capped backoff, never restarts a stop the user asked for.
/// Main-thread confined.
final class ServerProcess {
    enum State {
        /// No child, and none wanted.
        case stopped
        /// A child is alive (whether it is *serving* yet is the health poller's business).
        case running
        /// The child died unexpectedly; a respawn is scheduled.
        case retrying(at: Date)
        /// Cannot even spawn: bun or the install root is missing.
        case failed(reason: String)
    }

    /// Seconds to wait before each successive respawn.
    private static let backoffSchedule: [TimeInterval] = [1, 2, 5, 10, 20, 30]
    /// A child that lives at least this long is considered healthy enough to reset backoff.
    private static let stableUptime: TimeInterval = 30

    private(set) var state: State = .stopped { didSet { onStateChange?() } }
    private(set) var consecutiveFailures = 0
    var onStateChange: (() -> Void)?

    private var child: ChildProcess?
    private var retryWorkItem: DispatchWorkItem?
    private var startedAt: Date?
    /// Set while a user-requested restart is waiting for the old child to actually exit.
    private var isRestarting = false
    /// Bumped on every launch and every stop. An exit carrying an older generation belongs to
    /// a child we already gave up on, and must not touch the state of the current one.
    private var generation = 0
    /// User intent, kept separate from actual state so a crash loop still counts as "wanted".
    private(set) var shouldRun = false
    /// Resolves the layout to launch from. Injectable for tests.
    private let runtime: Runtime

    init(runtime: Runtime = .current) {
        self.runtime = runtime
    }

    /// True while a child exists or a respawn is pending — nothing else should start one.
    var isActive: Bool {
        switch state {
        case .running, .retrying: return true
        case .stopped, .failed: return false
        }
    }

    // MARK: - Intent

    func start() {
        shouldRun = true
        guard child == nil else { return }
        cancelRetry()
        launch()
    }

    func stop() {
        shouldRun = false
        isRestarting = false
        cancelRetry()
        consecutiveFailures = 0
        generation += 1
        if let child {
            log("stopping web server (pid \(child.pid))")
            self.child = nil
            child.terminate()
        }
        state = .stopped
    }

    func restart() {
        log("restart requested")
        shouldRun = true
        consecutiveFailures = 0
        cancelRetry()
        guard let child else {
            launch()
            return
        }
        // Respawn from the exit handler rather than right now: the old process still holds
        // the dashboard port, and a new one racing it would just fail to bind.
        isRestarting = true
        child.terminate(graceSeconds: 3)
    }

    /// Blocking teardown for app quit: the run loop stops right after, so no async escalation.
    func terminateSynchronously() {
        shouldRun = false
        isRestarting = false
        cancelRetry()
        generation += 1
        guard let child else { return }
        self.child = nil
        log("tray quitting, terminating web server (pid \(child.pid))")
        child.terminateAndWait()
    }

    // MARK: - Spawning

    private func launch() {
        // Where the dashboard lives is entirely `Runtime`'s decision (docs/PHASE4.md §1):
        // an installed .app runs its embedded bun against its embedded standalone build, a
        // checkout runs the package script. This file only spawns what it is handed.
        let resolved = runtime.resolveWebServer(dashboardPort: Paths.dashboardPort)
        guard case .success(let launch) = resolved else {
            if case .failure(let reason) = resolved { state = .failed(reason: reason) }
            return
        }

        let outputFD = LogFile.openForAppending(Paths.webLog)
        LogFile.writeLine(outputFD, "starting (\(launch.mode.rawValue)): \(launch.commandLine)")

        generation += 1
        let launched = generation
        let spawned = ChildProcess(
            executable: launch.executable,
            arguments: launch.arguments,
            workingDirectory: launch.workingDirectory,
            environment: childEnvironment(launch),
            outputFD: outputFD,
            onExit: { [weak self] exit in self?.handleExit(exit, generation: launched) }
        )
        if outputFD >= 0 { close(outputFD) }

        guard let spawned else {
            state = .failed(reason: "Could not launch \(launch.executable)")
            log("spawn failed for \(launch.commandLine)")
            return
        }
        child = spawned
        startedAt = Date()
        state = .running
    }

    private func handleExit(_ exit: ChildExit, generation launched: Int) {
        guard launched == generation else {
            log("superseded web server \(exit.description)")
            return
        }
        child = nil
        let uptime = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        log("web server \(exit.description) after \(Int(uptime))s")

        guard shouldRun else {
            state = .stopped
            return
        }
        if isRestarting {
            isRestarting = false
            consecutiveFailures = 0
            // Just long enough for the listening socket to be released.
            scheduleRetry(after: 0.25, reason: "restarting")
            return
        }
        if uptime >= Self.stableUptime { consecutiveFailures = 0 }
        let delay = Self.backoffSchedule[min(consecutiveFailures, Self.backoffSchedule.count - 1)]
        consecutiveFailures += 1
        scheduleRetry(after: delay, reason: "restarting in \(Int(delay))s (attempt \(consecutiveFailures))")
    }

    private func scheduleRetry(after delay: TimeInterval, reason: String) {
        cancelRetry()
        log(reason)
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.shouldRun, self.child == nil else { return }
            self.retryWorkItem = nil
            self.launch()
        }
        retryWorkItem = work
        state = .retrying(at: Date().addingTimeInterval(delay))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func cancelRetry() {
        retryWorkItem?.cancel()
        retryWorkItem = nil
    }

    /// The child inherits our environment, plus what the resolved layout needs, plus a PATH a
    /// Finder-launched `.app` does not get.
    private func childEnvironment(_ launch: WebServerLaunch) -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        for (key, value) in launch.environment { environment[key] = value }

        var pathEntries = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
        for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        where !pathEntries.contains(directory) {
            pathEntries.append(directory)
        }
        // The bun that runs the server comes first, so anything the server shells out to
        // finds the same runtime — in a bundle that is the embedded one, never a stray brew.
        let bunDirectory = (launch.executable as NSString).deletingLastPathComponent
        if !pathEntries.contains(bunDirectory) { pathEntries.insert(bunDirectory, at: 0) }
        environment["PATH"] = pathEntries.joined(separator: ":")
        return environment
    }

    private func log(_ message: String) {
        let fd = LogFile.openForAppending(Paths.webLog)
        LogFile.writeLine(fd, message)
        if fd >= 0 { close(fd) }
    }
}
