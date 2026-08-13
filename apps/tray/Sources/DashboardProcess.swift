import Darwin
import Foundation

/// Supervises the embedded dashboard as a child process.
///
/// Bundle mode: `Contents/Resources/bin/bun run Contents/Resources/dashboard/server.js`
/// (the `next build --output standalone` server).
/// Dev mode:    `bun run dev` inside `packages/dashboard`.
///
/// The dashboard is never started outside the app in production (docs/V2.md).
final class DashboardProcess {
    enum State: Equatable {
        case stopped
        case starting
        case running(pid: Int32)
        case backingOff(seconds: Int)
        case failed(String)
    }

    private let layout: RuntimeLayout
    private let log: Logger
    private let onStateChange: (State) -> Void

    private var process: Process?
    private var logHandle: FileHandle?
    private var restartAttempt = 0
    private var startedAt: Date?
    private var stopping = false
    private var retryTimer: Timer?

    /// 1s, 2s, 4s, 8s, 15s, then 30s forever.
    private let backoffLadder: [Int] = [1, 2, 4, 8, 15, 30]

    private(set) var state: State = .stopped {
        didSet { if state != oldValue { onStateChange(state) } }
    }

    init(layout: RuntimeLayout, log: Logger, onStateChange: @escaping (State) -> Void) {
        self.layout = layout
        self.log = log
        self.onStateChange = onStateChange
    }

    // MARK: - Lifecycle

    func start(port: Int) {
        cancelRetry()
        guard process == nil else { return }
        stopping = false

        let command = launchCommand(port: port)
        guard FileManager.default.isExecutableFile(atPath: command.executable) else {
            let message = "bun not found at \(command.executable)"
            log.log("dashboard: \(message)")
            state = .failed(message)
            return
        }
        guard FileManager.default.fileExists(atPath: command.workingDirectory) else {
            let message = "dashboard not found at \(command.workingDirectory)"
            log.log("dashboard: \(message)")
            state = .failed(message)
            return
        }

        state = .starting
        let task = Process()
        task.executableURL = URL(fileURLWithPath: command.executable)
        task.arguments = command.arguments
        task.currentDirectoryURL = URL(fileURLWithPath: command.workingDirectory)
        task.environment = command.environment

        let handle = Logger.appendHandle(at: Paths.dashboardLogPath)
        if let handle {
            task.standardOutput = handle
            task.standardError = handle
        }
        logHandle = handle

        task.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async { self?.handleExit(finished, port: port) }
        }

        do {
            try task.run()
        } catch {
            log.log("dashboard: launch failed — \(error.localizedDescription)")
            state = .failed(error.localizedDescription)
            scheduleRestart(port: port)
            return
        }

        process = task
        startedAt = Date()
        state = .running(pid: task.processIdentifier)
        log.log(
            "dashboard: started pid=\(task.processIdentifier) mode=\(layout.mode.rawValue) port=\(port)"
        )
    }

    func restart(port: Int) {
        log.log("dashboard: restart requested")
        restartAttempt = 0
        stop { [weak self] in self?.start(port: port) }
    }

    /// Terminates the child and waits briefly for it to go. Only ever signals the pid we
    /// launched — never a pattern, never a name.
    func stop(completion: (() -> Void)? = nil) {
        cancelRetry()
        stopping = true
        guard let task = process, task.isRunning else {
            process = nil
            closeLog()
            state = .stopped
            completion?()
            return
        }

        let pid = task.processIdentifier
        log.log("dashboard: stopping pid=\(pid)")
        task.terminate()  // SIGTERM to that pid only

        DispatchQueue.global().async { [weak self] in
            let deadline = Date().addingTimeInterval(5)
            while task.isRunning && Date() < deadline {
                usleep(100_000)
            }
            if task.isRunning {
                self?.log.log("dashboard: pid=\(pid) ignored SIGTERM, sending SIGKILL")
                kill(pid, SIGKILL)
            }
            DispatchQueue.main.async {
                self?.process = nil
                self?.closeLog()
                self?.state = .stopped
                completion?()
            }
        }
    }

    // MARK: - Restart policy

    private func handleExit(_ task: Process, port: Int) {
        guard process === task else { return }
        process = nil
        closeLog()
        let uptime = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        log.log(
            "dashboard: exited status=\(task.terminationStatus) after \(Int(uptime))s")

        guard !stopping else {
            state = .stopped
            return
        }
        // A long-lived process that dies is a fresh incident, not an escalation.
        if uptime > 30 { restartAttempt = 0 }
        scheduleRestart(port: port)
    }

    private func scheduleRestart(port: Int) {
        let delay = backoffLadder[min(restartAttempt, backoffLadder.count - 1)]
        restartAttempt += 1
        state = .backingOff(seconds: delay)
        log.log("dashboard: restarting in \(delay)s (attempt \(restartAttempt))")
        let timer = Timer(timeInterval: TimeInterval(delay), repeats: false) { [weak self] _ in
            self?.start(port: port)
        }
        RunLoop.main.add(timer, forMode: .common)
        retryTimer = timer
    }

    private func cancelRetry() {
        retryTimer?.invalidate()
        retryTimer = nil
    }

    private func closeLog() {
        try? logHandle?.close()
        logHandle = nil
    }

    // MARK: - Command

    private struct Command {
        let executable: String
        let arguments: [String]
        let workingDirectory: String
        let environment: [String: String]
    }

    private func launchCommand(port: Int) -> Command {
        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = String(port)
        environment["HOSTNAME"] = "127.0.0.1"
        environment["LA_DASHBOARD_PORT"] = String(port)
        environment["LA_RUNTIME_ROOT"] = layout.root

        var arguments: [String]
        switch layout.mode {
        case .bundle:
            environment["NODE_ENV"] = "production"
            arguments = ["run", "server.js"]
        case .dev:
            arguments = ["run", "dev"]
        }

        // In dev, bun may only be a name on PATH; env resolves it the way a shell would.
        var executable = layout.bun
        if !executable.hasPrefix("/") {
            arguments.insert(executable, at: 0)
            executable = "/usr/bin/env"
        }
        return Command(
            executable: executable,
            arguments: arguments,
            workingDirectory: layout.dashboardDir,
            environment: environment)
    }
}
