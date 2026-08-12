import Foundation

/// Which of the two layouts of `docs/PHASE4.md` §1 this process is running from.
enum RuntimeMode: String {
    /// A git checkout (or an install root): the dashboard is `bun run --cwd packages/web start`.
    case dev
    /// An installed `.app`: everything the app needs lives under `Contents/`.
    case bundle
}

/// A fully resolved command line for the dashboard. Produced by `Runtime`, executed by
/// `ServerProcess` — nothing else in the app decides where the web server comes from.
struct WebServerLaunch: Equatable {
    let executable: String
    let arguments: [String]
    let workingDirectory: String
    /// Layout-specific variables, merged over the inherited environment by `ServerProcess`.
    let environment: [String: String]
    let mode: RuntimeMode

    var commandLine: String { ([executable] + arguments).joined(separator: " ") }
}

/// The filesystem questions the resolver asks. Injected so resolution is a pure function
/// in tests: no temp trees, no real `/usr/local`.
struct FileProbe {
    let exists: (String) -> Bool
    let isExecutable: (String) -> Bool

    static let real = FileProbe(
        exists: { FileManager.default.fileExists(atPath: $0) },
        isExecutable: { FileManager.default.isExecutableFile(atPath: $0) }
    )
}

/// Resolves *where everything is* for the current process.
///
/// The frozen contract (`docs/PHASE4.md` §1):
///
/// |            | dev                                   | bundle                                     |
/// |------------|---------------------------------------|--------------------------------------------|
/// | detected by| `LA_RUNTIME=dev`, or no bundle marker | executable path contains `.app/Contents/`  |
/// | web server | `bun --bun next start` in packages/web | `Resources/bin/bun Resources/web/server.js`|
/// | helper     | `scripts/install.sh` (sudo)           | `SMAppService.daemon`, `MacOS/la-helper`   |
///
/// Nothing here may assume a git checkout exists.
struct Runtime {
    /// Where `scripts/install.sh` copies the dev/script-install runtime.
    static let installRoot = "/usr/local/lib/localhost-aliases"
    /// Filename of the daemon plist, both inside `Contents/Library/LaunchDaemons/` and as the
    /// argument to `SMAppService.daemon(plistName:)`. The two must be identical.
    static let helperPlistName = "dev.localhost-aliases.helper.plist"

    let executablePath: String
    let environment: [String: String]
    let probe: FileProbe

    /// The running process.
    static let current = Runtime(
        executablePath: Bundle.main.executablePath ?? CommandLine.arguments.first ?? "",
        environment: ProcessInfo.processInfo.environment,
        probe: .real
    )

    // MARK: - Layout

    /// `…/LocalhostAliases.app/Contents`, or nil when the executable is not inside a bundle.
    var contentsDirectory: String? {
        Self.contentsDirectory(forExecutable: executablePath)
    }

    /// Path marker only — deliberately not "is the payload complete?". A bundle missing its
    /// payload is a broken install we must report as such, not silently treat as a checkout.
    var mode: RuntimeMode {
        if environment["LA_RUNTIME"] == "dev" { return .dev }
        if environment["LA_RUNTIME"] == "bundle" { return .bundle }
        return contentsDirectory == nil ? .dev : .bundle
    }

    /// The daemon plist `SMAppService` will look for, when it exists on disk.
    var helperPlistPath: String? {
        guard let contents = contentsDirectory else { return nil }
        let path = contents + "/Library/LaunchDaemons/" + Self.helperPlistName
        return probe.exists(path) ? path : nil
    }

    /// The compiled root helper shipped in the bundle.
    var bundledHelperPath: String? {
        guard let contents = contentsDirectory else { return nil }
        let path = contents + "/MacOS/la-helper"
        return probe.exists(path) ? path : nil
    }

    /// True only when this build can actually install the daemon: a real bundle carrying both
    /// halves `SMAppService.daemon` needs. Every call site that registers the daemon is gated
    /// on this, so a checkout build can never install anything.
    var canInstallHelperViaBundle: Bool {
        mode == .bundle && helperPlistPath != nil && bundledHelperPath != nil
    }

    // MARK: - Web server

    /// The command that starts the dashboard, or a human-readable reason it cannot start.
    func resolveWebServer(dashboardPort: Int) -> Result<WebServerLaunch, String> {
        if mode == .bundle {
            switch bundleLaunch(dashboardPort: dashboardPort) {
            case .success(let launch):
                return .success(launch)
            case .failure(let bundleProblem):
                // A `.app` assembled by `make app` for development carries the tray and
                // nothing else. Falling back keeps that build usable; a real install never
                // reaches here, and if the checkout is absent too we report the bundle
                // problem, which is the one the user has to fix.
                guard case .success(let launch) = devLaunch(dashboardPort: dashboardPort) else {
                    return .failure(bundleProblem)
                }
                return .success(launch)
            }
        }
        return devLaunch(dashboardPort: dashboardPort)
    }

    private func bundleLaunch(dashboardPort: Int) -> Result<WebServerLaunch, String> {
        guard let contents = contentsDirectory else {
            return .failure("LA_RUNTIME=bundle but the executable is not inside a .app")
        }
        let bun = contents + "/Resources/bin/bun"
        let webDirectory = contents + "/Resources/web"
        let server = webDirectory + "/server.js"
        guard probe.isExecutable(bun) else {
            return .failure("Damaged app: Contents/Resources/bin/bun is missing")
        }
        guard probe.exists(server) else {
            return .failure("Damaged app: Contents/Resources/web/server.js is missing")
        }
        return .success(WebServerLaunch(
            executable: bun,
            // `--bun` is belt and braces: the standalone server must never re-exec under Node,
            // which is what breaks every Bun-native call in @localhost-aliases/core.
            arguments: ["--bun", server],
            workingDirectory: webDirectory,
            environment: [
                // What Next's standalone server.js reads. Both are required: its default
                // hostname is 0.0.0.0, and this dashboard is loopback-only.
                "PORT": String(dashboardPort),
                "HOSTNAME": "127.0.0.1",
                "LA_DASHBOARD_PORT": String(dashboardPort),
                "NODE_ENV": "production",
            ],
            mode: .bundle
        ))
    }

    private func devLaunch(dashboardPort: Int) -> Result<WebServerLaunch, String> {
        guard let root = developmentRoot() else {
            return .failure("Runtime not found — expected \(Self.installRoot) or a checkout")
        }
        guard let bun = systemBun() else {
            return .failure("bun not found — install it or set LA_BUN")
        }
        return .success(WebServerLaunch(
            executable: bun,
            // Goes through the package script on purpose: it carries `--bun`.
            arguments: ["run", "--cwd", root + "/packages/web", "start"],
            workingDirectory: root,
            environment: [
                "LA_DASHBOARD_PORT": String(dashboardPort),
                "NODE_ENV": "production",
            ],
            mode: .dev
        ))
    }

    // MARK: - Discovery (dev only)

    /// The directory containing `packages/web`: an install root, or the checkout the binary
    /// sits in.
    func developmentRoot() -> String? {
        var candidates: [String] = []
        if let override = environment["LA_INSTALL_ROOT"], !override.isEmpty { candidates.append(override) }
        candidates.append(Self.installRoot)
        candidates.append(contentsOf: Self.ancestors(of: executablePath))
        return candidates.first { probe.exists($0 + "/packages/web/package.json") }
    }

    /// A `.app` launched from Finder inherits a bare PATH, so bun has to be located explicitly.
    func systemBun() -> String? {
        var candidates: [String] = []
        if let override = environment["LA_BUN"], !override.isEmpty { candidates.append(override) }
        candidates += (environment["PATH"] ?? "").split(separator: ":").map { "\($0)/bun" }
        let home = environment["HOME"] ?? NSHomeDirectory()
        candidates += ["/opt/homebrew/bin/bun", "/usr/local/bin/bun", home + "/.bun/bin/bun"]
        return candidates.first { probe.isExecutable($0) }
    }

    // MARK: - Path helpers (pure)

    /// Finds the `<name>.app/Contents` ancestor of an executable path, if any.
    static func contentsDirectory(forExecutable path: String) -> String? {
        let components = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard let appIndex = components.lastIndex(where: { $0.hasSuffix(".app") }),
              appIndex + 1 < components.count,
              components[appIndex + 1] == "Contents"
        else { return nil }
        return components[0...(appIndex + 1)].joined(separator: "/")
    }

    /// Directories above `path`, nearest first. Deep enough to climb out of
    /// `apps/tray/X.app/Contents/MacOS/` and reach the checkout root.
    static func ancestors(of path: String, levels: Int = 8) -> [String] {
        var directory = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        var result: [String] = []
        for _ in 0..<levels {
            directory.deleteLastPathComponent()
            let candidate = directory.path
            if candidate == "/" || candidate.isEmpty { break }
            result.append(candidate)
        }
        return result
    }
}
