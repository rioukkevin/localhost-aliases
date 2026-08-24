import Foundation

/// Swift mirror of `packages/core/src/paths.ts`. That file is the frozen contract;
/// every location here must match it exactly, including the `LA_*` overrides.
enum Paths {
    static let appName = "Localhost Aliases"
    static let bundleId = "dev.localhost-aliases.app"

    /// How often the app touches the liveness file (paths.ts: LIVENESS_TOUCH_MS).
    static let livenessTouchInterval: TimeInterval = 5

    static func env(_ key: String) -> String? {
        guard let value = ProcessInfo.processInfo.environment[key], !value.isEmpty else { return nil }
        return value
    }

    static var home: String { NSHomeDirectory() }

    static var configDir: String {
        env("LA_CONFIG_DIR") ?? "\(home)/.config/localhost-aliases"
    }
    static var configPath: String { "\(configDir)/config.json" }
    static var desiredStatePath: String { "\(configDir)/desired-state.json" }
    static var routesPath: String { "\(configDir)/routes.json" }
    static var forwarderStatusPath: String { "\(configDir)/forwarder-status.json" }
    static var livenessPath: String { "\(configDir)/liveness" }

    /// Dashboard -> tray privileged request channel (paths.ts: applyRequestPath/applyResultPath).
    static var applyRequestPath: String { "\(configDir)/apply-request.json" }
    static var applyResultPath: String { "\(configDir)/apply-result.json" }
    /// paths.ts: APPLY_POLL_MS (1s — it is only a stat plus a small read).
    static let applyPollInterval: TimeInterval = 1
    /// paths.ts: APPLY_REQUEST_TTL_MS. Anything older is a leftover, never a click.
    static let applyRequestTtl: TimeInterval = 90

    /// Launch-at-login channel, same shape as the privileged one (see LoginItem.swift).
    /// These two files are owned by the tray: paths.ts is frozen, and only a Swift process can
    /// read SMAppService, so the contract lives here and the dashboard mirrors it.
    ///   login-item.json          tray -> dashboard, the real SMAppService.Status
    ///   login-item-request.json  dashboard -> tray, { id, action, requestedAt }
    static var loginItemStatusPath: String { "\(configDir)/login-item.json" }
    static var loginItemRequestPath: String { "\(configDir)/login-item-request.json" }

    static var logDir: String {
        env("LA_LOG_DIR") ?? "\(home)/Library/Logs/localhost-aliases"
    }
    static var trayLogPath: String { "\(logDir)/tray.log" }
    static var dashboardLogPath: String { "\(logDir)/dashboard.log" }

    static func ensureDirectory(_ path: String) {
        try? FileManager.default.createDirectory(
            atPath: path, withIntermediateDirectories: true, attributes: nil)
    }
}
