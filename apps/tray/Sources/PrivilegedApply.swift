import Foundation

// =============================================================================================
//  THE ONLY PLACE IN THIS APP THAT ASKS FOR ADMINISTRATOR RIGHTS.
//
//  Nothing here runs on its own. `run(...)` is reachable from exactly two explicit menu
//  actions — "Re-apply Aliases" and "Uninstall…" — each behind a confirmation dialog
//  (see MenuBuilder.Action and AppDelegate.reapply / AppDelegate.uninstall).
//  There is no timer, no launch-time call, and no retry loop pointing at it.
//
//  Everything privileged happens in ONE batch inside packages/privileged (docs/V2.md):
//  lo0 aliases, the /etc/hosts managed block, the DNS flush, and starting the forwarder.
//  This file only chooses the entrypoint and raises the macOS prompt.
//
//  Set LA_NO_PRIVILEGED=1 to hard-disable it while developing.
// =============================================================================================

enum PrivilegedApply {
    enum Kind {
        case apply
        case uninstall

        /// Argument handed to prompt.ts, the preferred entrypoint.
        var flag: String? {
            switch self {
            case .apply: return nil
            case .uninstall: return "--uninstall"
            }
        }

        /// Script used by the osascript fallback when prompt.ts is not shipped.
        var scriptName: String {
            switch self {
            case .apply: return "apply.sh"
            case .uninstall: return "uninstall.sh"
            }
        }
    }

    struct Result {
        let ok: Bool
        /// True when the user dismissed the macOS password dialog (osascript error -128).
        let cancelled: Bool
        let output: String
    }

    static var isDisabled: Bool { Paths.env("LA_NO_PRIVILEGED") != nil }

    /// Runs the privileged batch and calls back on the main queue.
    static func run(
        layout: RuntimeLayout,
        kind: Kind,
        log: Logger,
        completion: @escaping (Result) -> Void
    ) {
        if isDisabled {
            log.log("privileged: refused — LA_NO_PRIVILEGED is set")
            completion(Result(ok: false, cancelled: false, output: "LA_NO_PRIVILEGED is set"))
            return
        }

        guard let command = command(layout: layout, kind: kind) else {
            let message = "privileged entrypoint missing at \(layout.privilegedDir)"
            log.log("privileged: \(message)")
            completion(Result(ok: false, cancelled: false, output: message))
            return
        }

        log.log("privileged: running \(command.executable) \(command.arguments.joined(separator: " "))")
        DispatchQueue.global().async {
            let result = execute(command)
            log.log("privileged: finished ok=\(result.ok) cancelled=\(result.cancelled)")
            DispatchQueue.main.async { completion(result) }
        }
    }

    // MARK: - Command construction

    struct Command {
        let executable: String
        let arguments: [String]
    }

    /// Preferred: `bun run <privileged>/prompt.ts [--uninstall]`, the wrapper that owns the
    /// osascript incantation. Fallback (when prompt.ts is not shipped): raise the same prompt
    /// here around apply.sh. Both end in exactly one `with administrator privileges` dialog.
    static func command(layout: RuntimeLayout, kind: Kind) -> Command? {
        let files = FileManager.default
        if files.fileExists(atPath: layout.promptScript) {
            var arguments = ["run", layout.promptScript]
            if let flag = kind.flag { arguments.append(flag) }
            var executable = layout.bun
            if !executable.hasPrefix("/") {
                arguments.insert(executable, at: 0)
                executable = "/usr/bin/env"
            }
            return Command(executable: executable, arguments: arguments)
        }

        let scriptPath = "\(layout.privilegedDir)/\(kind.scriptName)"
        guard files.fileExists(atPath: scriptPath) else { return nil }
        // `do shell script` starts from a bare environment, so the LA_* inputs the scripts
        // document have to be spelled out on the command line.
        var shell =
            "LA_CONFIG_DIR=" + shellQuote(Paths.configDir)
            + " LA_FORWARDER=" + shellQuote(layout.forwarder)
            + " LA_LOG_DIR=" + shellQuote(Paths.logDir)
            // Root creates hosts.original and the log directory inside the user's own
            // directories; without LA_OWNER they stay root-owned and the tray can no
            // longer write dashboard.log next to them.
            + " LA_OWNER=" + shellQuote("\(getuid()):\(getgid())")
        // Restrict lo0 removals to the addresses this install actually allocated. Without
        // it apply.sh/uninstall.sh treat every free 127.0.0.2-254 address on lo0 as theirs
        // and will remove one the user added by hand for something unrelated.
        if let managed = managedIps(), !managed.isEmpty {
            shell += " LA_MANAGED_IPS=" + shellQuote(managed.joined(separator: " "))
        }
        shell += " /bin/bash " + shellQuote(scriptPath)
        if kind == .apply { shell += " " + shellQuote(Paths.desiredStatePath) }
        let script = "do shell script \(appleScriptQuote(shell)) with administrator privileges"
        return Command(executable: "/usr/bin/osascript", arguments: ["-e", script])
    }

    /// Every loopback address config.json has handed out, sorted and de-duplicated.
    /// Nil when the config cannot be read, which leaves LA_MANAGED_IPS unset and the
    /// scripts on their documented "the whole pool is ours" default.
    static func managedIps() -> [String]? {
        let ips = AppConfig.load().aliases.map { $0.ip }.filter { !$0.isEmpty }
        return ips.isEmpty ? nil : Array(Set(ips)).sorted()
    }

    static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    static func appleScriptQuote(_ value: String) -> String {
        let escaped =
            value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"" + escaped + "\""
    }

    // MARK: - Execution

    private static func execute(_ command: Command) -> Result {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: command.executable)
        task.arguments = command.arguments
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe

        do {
            try task.run()
        } catch {
            return Result(ok: false, cancelled: false, output: error.localizedDescription)
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        let output = String(data: data, encoding: .utf8) ?? ""
        // osascript reports a dismissed password dialog as "User canceled. (-128)".
        let cancelled = output.contains("-128") || output.localizedCaseInsensitiveContains("cancel")
        return Result(ok: task.terminationStatus == 0, cancelled: cancelled, output: output)
    }
}
