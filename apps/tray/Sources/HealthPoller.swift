import Foundation

/// One alias as served by `GET /api/aliases` (a subset of core's `AliasView`).
///
/// Decoding is deliberately forgiving: a menu is not worth losing because the API grew or
/// dropped a field.
struct Alias: Decodable {
    let name: String
    let hostname: String
    let url: String
    let port: Int
    let status: String
    let enabled: Bool

    var isUp: Bool { status == "up" }

    private enum CodingKeys: String, CodingKey {
        case name, hostname, url, port, status, enabled
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        hostname = try container.decodeIfPresent(String.self, forKey: .hostname) ?? name
        port = try container.decodeIfPresent(Int.self, forKey: .port) ?? 0
        url = try container.decodeIfPresent(String.self, forKey: .url) ?? "http://\(hostname)"
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? "unknown"
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }
}

/// Outcome of one poll cycle.
enum HealthResult {
    /// `/api/status` answered; the aliases are whatever `/api/aliases` returned (possibly none).
    case healthy(SystemStatusSummary, [Alias])
    /// Nothing is serving on the dashboard port, or it answered with an error.
    case unhealthy(String)
}

/// Polls the web API every 5s: `/api/status` for liveness *and* system state, `/api/aliases`
/// for the menu.
///
/// Liveness deliberately rides `/api/status` rather than the cheaper `/api/health`: the
/// dashboard's helper drift reconciliation runs inside that handler (see
/// `packages/web/lib/reconcile.ts`). With the tray polling `/api/health`, a helper restart
/// with no browser tab open left every alias dead until the user happened to edit something.
/// This poll is the thing that keeps routes alive on a headless desktop.
///
/// Requests are short-timeout and non-overlapping — a wedged server must never queue up
/// work behind it. Results are delivered on the main queue.
final class HealthPoller {
    private static let interval: TimeInterval = 5
    private static let requestTimeout: TimeInterval = 2.5

    var onResult: ((HealthResult) -> Void)?

    private let session: URLSession
    private var timer: Timer?
    private var inFlight = false

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = Self.requestTimeout
        configuration.timeoutIntervalForResource = Self.requestTimeout
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        session = URLSession(configuration: configuration)
    }

    func start() {
        guard timer == nil else { return }
        let timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) { [weak self] _ in
            self?.poll()
        }
        timer.tolerance = 1
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        poll()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// Immediate out-of-band refresh (menu opening, after a restart).
    func poll() {
        guard !inFlight else { return }
        inFlight = true
        let deliver = makeDelivery()

        fetch(Paths.api("api/status")) { [session] result in
            guard case .success(let statusData) = result else {
                if case .failure(let reason) = result { deliver(.unhealthy(reason)) }
                return
            }
            guard let summary = try? JSONDecoder().decode(SystemStatusSummary.self, from: statusData) else {
                // The port answered but not with our API. Treat as down rather than guess.
                deliver(.unhealthy("Unexpected response from /api/status"))
                return
            }
            Self.fetch(Paths.api("api/aliases"), session: session) { aliasResult in
                guard case .success(let data) = aliasResult,
                      let payload = try? JSONDecoder().decode(AliasesPayload.self, from: data)
                else {
                    deliver(.healthy(summary, []))
                    return
                }
                deliver(.healthy(summary, payload.aliases))
            }
        }
    }

    // MARK: - Private

    private struct AliasesPayload: Decodable {
        let aliases: [Alias]
    }

    /// One request's outcome. Failures are human-readable strings, not errors — they are
    /// only ever shown in the menu.
    private enum Fetched {
        case success(Data)
        case failure(String)
    }

    /// Single exit point: clears `inFlight` and hands the result to the main queue exactly once.
    private func makeDelivery() -> (HealthResult) -> Void {
        var delivered = false
        return { [weak self] result in
            DispatchQueue.main.async {
                guard let self, !delivered else { return }
                delivered = true
                self.inFlight = false
                self.onResult?(result)
            }
        }
    }

    private func fetch(_ url: URL, completion: @escaping (Fetched) -> Void) {
        Self.fetch(url, session: session, completion: completion)
    }

    private static func fetch(
        _ url: URL,
        session: URLSession,
        completion: @escaping (Fetched) -> Void
    ) {
        session.dataTask(with: url) { data, response, error in
            if let error {
                completion(.failure((error as NSError).localizedDescription))
                return
            }
            guard let http = response as? HTTPURLResponse else {
                completion(.failure("No response from \(url.host ?? "server")"))
                return
            }
            guard (200..<300).contains(http.statusCode) else {
                completion(.failure("HTTP \(http.statusCode) from \(url.path)"))
                return
            }
            completion(.success(data ?? Data()))
        }.resume()
    }
}
