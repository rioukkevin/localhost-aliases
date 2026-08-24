import Foundation

/// Touches the liveness file every 5s.
///
/// This is the whole reason the root forwarder can be stopped without root: a user process
/// cannot kill a root process, so the forwarder watches this file and exits on its own once
/// it goes stale (LIVENESS_TIMEOUT_MS in paths.ts). Stopping the heartbeat — and removing the
/// file on quit — is how the app shuts the forwarder down. Nothing else may write this file.
final class Heartbeat {
    private let log: Logger
    private var timer: Timer?

    init(log: Logger) {
        self.log = log
    }

    func start() {
        stop(removeFile: false)
        touch()
        let timer = Timer(timeInterval: Paths.livenessTouchInterval, repeats: true) {
            [weak self] _ in self?.touch()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        log.log("heartbeat: touching \(Paths.livenessPath) every \(Int(Paths.livenessTouchInterval))s")
    }

    /// On quit the file is removed as well, so the forwarder exits immediately instead of
    /// waiting out the staleness window.
    func stop(removeFile: Bool = true) {
        timer?.invalidate()
        timer = nil
        guard removeFile else { return }
        try? FileManager.default.removeItem(atPath: Paths.livenessPath)
        log.log("heartbeat: stopped, liveness file removed")
    }

    /// Touches the file, but never CREATES the directory it lives in.
    ///
    /// It used to. That made the heartbeat able to resurrect ~/.config/localhost-aliases a
    /// second after the uninstall removed it, leaving a directory behind on a machine the user
    /// had just cleaned. The dashboard creates the config directory when it writes config.json,
    /// which is long before any root agent exists to watch this file — so nothing is lost by
    /// declining to create it here, and a removed directory stays removed.
    private func touch() {
        guard FileManager.default.fileExists(atPath: Paths.configDir) else { return }
        let stamp = ISO8601DateFormatter().string(from: Date())
        // Rewriting the file updates both its contents and its mtime, so the forwarder can
        // use whichever it prefers.
        try? stamp.write(toFile: Paths.livenessPath, atomically: false, encoding: .utf8)
    }
}
