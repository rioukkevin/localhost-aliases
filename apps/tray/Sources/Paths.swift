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
