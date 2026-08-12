import Foundation

/// URLs and log locations the tray touches.
///
/// The Swift mirror of `packages/core/src/paths.ts` — the two must stay in sync. Where things
/// *are on disk* (bun, the web server, the daemon plist) is `Runtime`'s job, not this file's.
enum Paths {
    static let defaultDashboardPort = 7788

    private static var env: [String: String] { ProcessInfo.processInfo.environment }

    static var home: URL { FileManager.default.homeDirectoryForCurrentUser }

    // MARK: - Web API

    static var dashboardPort: Int {
        if let raw = env["LA_DASHBOARD_PORT"], let port = Int(raw), (1...65535).contains(port) {
            return port
        }
        return defaultDashboardPort
    }

    static var dashboardURL: URL {
        URL(string: "http://127.0.0.1:\(dashboardPort)")!
    }

    /// `api("api/status")` -> `http://127.0.0.1:7788/api/status`
    static func api(_ path: String) -> URL {
        dashboardURL.appendingPathComponent(path)
    }

    // MARK: - Logs

    static var logDirectory: URL {
        if let dir = env["LA_LOG_DIR"], !dir.isEmpty { return URL(fileURLWithPath: dir) }
        return home.appendingPathComponent("Library/Logs/localhost-aliases", isDirectory: true)
    }

    /// stdout+stderr of the supervised web server.
    static var webLog: URL { logDirectory.appendingPathComponent("web.log") }
}
