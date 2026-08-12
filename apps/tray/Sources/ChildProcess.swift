import Foundation

/// How a child process ended.
struct ChildExit {
    let code: Int32
    let signal: Int32?

    var wasClean: Bool { signal == nil && code == 0 }

    var description: String {
        if let signal { return "killed by signal \(signal)" }
        return "exited with code \(code)"
    }
}

/// One spawned process, in its own process group, with stdout/stderr pointed at a file
/// descriptor.
///
/// `Foundation.Process` cannot put a child in a new process group, and that matters here:
/// `bun run … start` spawns `next` as a grandchild, so quitting must signal the whole group
/// or the web server survives the tray. Hence `posix_spawn` with `POSIX_SPAWN_SETPGROUP`.
///
/// Main-thread confined: create it, signal it and receive `onExit` on the main queue only.
final class ChildProcess {
    let pid: pid_t
    private var exitSource: DispatchSourceProcess?
    private var isReaped = false

    /// Spawns immediately. Returns `nil` when `posix_spawn` fails (missing binary, bad cwd…).
    /// `onExit` is delivered once, on the main queue.
    init?(
        executable: String,
        arguments: [String],
        workingDirectory: String,
        environment: [String: String],
        outputFD: Int32,
        onExit: @escaping (ChildExit) -> Void
    ) {
        var fileActions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fileActions)
        defer { posix_spawn_file_actions_destroy(&fileActions) }
        posix_spawn_file_actions_addchdir_np(&fileActions, workingDirectory)
        posix_spawn_file_actions_addopen(&fileActions, 0, "/dev/null", O_RDONLY, 0)
        if outputFD >= 0 {
            posix_spawn_file_actions_adddup2(&fileActions, outputFD, 1)
            posix_spawn_file_actions_adddup2(&fileActions, outputFD, 2)
        }

        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        // pgroup 0 => the child becomes the leader of a brand new group == its own pid.
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&attributes, 0)

        var argv: [UnsafeMutablePointer<CChar>?] = ([executable] + arguments).map { strdup($0) }
        argv.append(nil)
        var envp: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") }
        envp.append(nil)
        defer {
            for pointer in argv { free(pointer) }
            for pointer in envp { free(pointer) }
        }

        var spawned: pid_t = 0
        let status = posix_spawn(&spawned, executable, &fileActions, &attributes, argv, envp)
        guard status == 0, spawned > 0 else { return nil }
        pid = spawned

        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        source.setEventHandler { [weak self] in
            guard let self, let exit = self.reap(blocking: false) else { return }
            self.exitSource?.cancel()
            self.exitSource = nil
            onExit(exit)
        }
        source.resume()
        exitSource = source
    }

    /// Asks the whole process group to stop. Escalates to SIGKILL after `graceSeconds`.
    ///
    /// The escalation captures `self` strongly on purpose: the owner drops its reference as
    /// soon as it asks for termination, and if this object died with it, a child that ignores
    /// SIGTERM would never be killed nor reaped.
    func terminate(graceSeconds: TimeInterval = 5) {
        guard !isReaped else { return }
        signalGroup(SIGTERM)
        DispatchQueue.main.asyncAfter(deadline: .now() + graceSeconds) {
            guard !self.isReaped else { return }
            self.signalGroup(SIGKILL)
            self.exitSource?.cancel()
            self.exitSource = nil
            // SIGKILL cannot be caught, so this returns immediately.
            self.reap(blocking: true)
        }
    }

    /// Blocking stop, for app teardown where the run loop is about to disappear.
    /// SIGTERM, poll for `timeout`, then SIGKILL and reap.
    func terminateAndWait(timeout: TimeInterval = 4) {
        guard !isReaped else { return }
        exitSource?.cancel()
        exitSource = nil
        signalGroup(SIGTERM)

        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if reap(blocking: false) != nil { return }
            usleep(50_000)
        }
        signalGroup(SIGKILL)
        _ = reap(blocking: true)
    }

    var isRunning: Bool { !isReaped }

    // MARK: - Private

    /// Negative pid == "the whole process group", which is how `next` dies with `bun`.
    private func signalGroup(_ number: Int32) {
        if kill(-pid, number) == -1 && errno == ESRCH {
            kill(pid, number)
        }
    }

    @discardableResult
    private func reap(blocking: Bool) -> ChildExit? {
        guard !isReaped else { return nil }
        var status: Int32 = 0
        var result: pid_t
        repeat {
            result = waitpid(pid, &status, blocking ? 0 : WNOHANG)
        } while result == -1 && errno == EINTR
        guard result == pid || (result == -1 && errno == ECHILD) else { return nil }
        isReaped = true
        if result == -1 { return ChildExit(code: -1, signal: nil) }

        let terminatedBySignal = (status & 0o177) != 0 && (status & 0o177) != 0o177
        if terminatedBySignal {
            return ChildExit(code: -1, signal: status & 0o177)
        }
        return ChildExit(code: (status >> 8) & 0xFF, signal: nil)
    }
}
