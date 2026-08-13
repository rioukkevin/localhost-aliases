import Darwin
import Foundation

/// Polls the two sources of truth the tray is allowed to read:
///   1. the embedded dashboard's `/api/state` (authoritative — it owns the diffing logic)
///   2. `forwarder-status.json` + `config.json` on disk, as a fallback while the dashboard boots
///
/// The tray deliberately does not re-implement desired-state diffing; that lives in
/// packages/core and is reached over the local API.
final class StatusPoller {
    private let interval: TimeInterval
    private let log: Logger
    private let onUpdate: (AppConfig, SystemSnapshot, [String: Bool]) -> Void
    private var timer: Timer?
    private let queue = DispatchQueue(label: "dev.localhost-aliases.poll")
    private var inFlight = false

    init(
        interval: TimeInterval = 3,
        log: Logger,
        onUpdate: @escaping (AppConfig, SystemSnapshot, [String: Bool]) -> Void
    ) {
        self.interval = interval
        self.log = log
        self.onUpdate = onUpdate
    }

    func start() {
        stop()
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        tick()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func refreshSoon() { tick() }

    private func tick() {
        guard !inFlight else { return }
        inFlight = true
        queue.async { [weak self] in
            guard let self else { return }
            let config = AppConfig.load()
            var snapshot = self.readForwarderStatus()
            if let remote = self.fetchDashboardState(port: config.dashboardPort) {
                snapshot.dashboardReachable = true
                snapshot.applied = remote.applied ?? snapshot.applied
                snapshot.drift = remote.drift ?? snapshot.drift
                snapshot.needsPrompt = remote.needsPrompt ?? !(remote.applied ?? true)
                if let running = remote.forwarderRunning { snapshot.forwarderRunning = running }
            } else {
                snapshot.dashboardReachable = false
                snapshot.applied = false
            }
            snapshot.checkedAt = Date()

            var statuses: [String: Bool] = [:]
            for alias in config.aliases where alias.enabled {
                statuses[alias.id] = PortProbe.isOpen(port: alias.port)
            }

            DispatchQueue.main.async {
                self.inFlight = false
                self.onUpdate(config, snapshot, statuses)
            }
        }
    }

    // MARK: - Sources

    private struct RemoteState {
        var applied: Bool?
        var drift: [String]?
        var needsPrompt: Bool?
        var forwarderRunning: Bool?
    }

    /// Tolerant on purpose: the dashboard may nest the SystemState under `system` or `state`,
    /// and a missing key must degrade rather than throw the whole poll away.
    private func fetchDashboardState(port: Int) -> RemoteState? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/state") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        request.cachePolicy = .reloadIgnoringLocalCacheData

        let semaphore = DispatchSemaphore(value: 0)
        var payload: Data?
        var status = 0
        let task = URLSession.shared.dataTask(with: request) { data, response, _ in
            payload = data
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
            semaphore.signal()
        }
        task.resume()
        if semaphore.wait(timeout: .now() + 3) == .timedOut {
            task.cancel()
            return nil
        }
        guard status == 200, let payload,
            let root = try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
        else { return nil }

        let object = (root["system"] as? [String: Any]) ?? (root["state"] as? [String: Any]) ?? root
        var state = RemoteState()
        state.applied = object["applied"] as? Bool
        state.drift = (object["drift"] as? [Any])?.compactMap { $0 as? String }
        state.needsPrompt = object["needsPrompt"] as? Bool
        if let forwarder = object["forwarder"] as? [String: Any] {
            state.forwarderRunning = (forwarder["pid"] as? Int).map { isAlive(pid: Int32($0)) } ?? true
        } else if object.keys.contains("forwarder") {
            state.forwarderRunning = false
        }
        return state
    }

    private func readForwarderStatus() -> SystemSnapshot {
        var snapshot = SystemSnapshot()
        guard let data = FileManager.default.contents(atPath: Paths.forwarderStatusPath),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let pid = object["pid"] as? Int
        else { return snapshot }
        snapshot.forwarderPid = pid
        snapshot.forwarderRunning = isAlive(pid: Int32(pid))
        return snapshot
    }

    /// Signal 0 delivers nothing; it only asks whether the pid exists. EPERM means it exists
    /// and belongs to root — which is exactly the forwarder.
    private func isAlive(pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        if kill(pid, 0) == 0 { return true }
        return errno == EPERM
    }
}
