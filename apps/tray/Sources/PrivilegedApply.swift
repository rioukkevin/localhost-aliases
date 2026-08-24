import Foundation

// =============================================================================================
//  THE ONLY PLACE IN THIS APP THAT ASKS FOR ADMINISTRATOR RIGHTS.
//
//  Nothing here runs on its own. `run(...)` is reachable from exactly two explicit menu
//  actions — "Re-apply Aliases" and "Uninstall…" — each behind a confirmation dialog
//  (see MenuBuilder.Action and AppDelegate.reapply / AppDelegate.uninstall).
//  There is no timer, no launch-time call, and no retry loop pointing at it.
//
//  `runTeardown(...)` is the second entrypoint. It does NOT run with administrator
//  privileges: it starts the shipped teardown.sh as this user, and that script raises the one
//  prompt itself for the one step that needs root. Same rule — an explicit action, behind a
//  confirmation that lists what is about to be removed.
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

    // MARK: - The full uninstall

    /// Runs `teardown.sh` — the WHOLE uninstall, the same file `make uninstall` runs, shipped
    /// inside the bundle so none of this needs a source tree.
    ///
    /// It is not launched with administrator privileges: it runs as the user and raises the
    /// one admin prompt itself, for the one step that needs root. Everything after that step
    /// is the user's own files and needs no password.
    ///
    /// What is built here — the argv, the environment, the parsing of the report — lives in
    /// Uninstaller.swift and is unit-tested. This function is only the Process.
    static func runTeardown(
        layout: RuntimeLayout,
        appBundle: String?,
        waitPid: Int32?,
        log: Logger,
        completion: @escaping (Uninstaller.Report, Result) -> Void
    ) {
        let command = Uninstaller.command(
            privilegedDir: layout.privilegedDir,
            configDir: Paths.configDir,
            logDir: Paths.logDir,
            appBundle: appBundle,
            forwarder: layout.forwarder,
            waitPid: waitPid,
            managedIps: managedIps())

        if isDisabled {
            log.log("uninstall: refused — LA_NO_PRIVILEGED is set")
            let result = Result(ok: false, cancelled: false, output: "LA_NO_PRIVILEGED is set")
            completion(Uninstaller.parse(""), result)
            return
        }
        guard FileManager.default.fileExists(atPath: command.arguments[0]) else {
            let message = "teardown.sh is missing at \(command.arguments[0])"
            log.log("uninstall: \(message)")
            completion(Uninstaller.parse(""), Result(ok: false, cancelled: false, output: message))
            return
        }

        log.log("uninstall: running \(command.arguments[0]) app=\(appBundle ?? "none") pid=\(waitPid.map(String.init) ?? "none")")
        DispatchQueue.global().async {
            let outcome = executeTeardown(command)
            let report = Uninstaller.parse(outcome.output)
            log.log("uninstall: \(report.outcome.rawValue) app=\(report.app) steps=\(report.steps.map { "\($0.name)=\($0.status.rawValue)" }.joined(separator: " "))")
            DispatchQueue.main.async { completion(report, outcome) }
        }
    }

    /// Its own runner rather than `execute`: teardown.sh needs an environment, and its exit
    /// code carries three outcomes (0 done, 1 partial, 2 cancelled) instead of two.
    private static func executeTeardown(_ command: Uninstaller.Command) -> Result {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: command.executable)
        task.arguments = command.arguments
        // Inherit, then override: the script needs a real PATH, HOME and TMPDIR.
        var environment = ProcessInfo.processInfo.environment
        for (key, value) in command.environment { environment[key] = value }
        task.environment = environment

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
        // 2 is the script's own code for "the user dismissed the password dialog".
        return Result(
            ok: task.terminationStatus == 0,
            cancelled: task.terminationStatus == 2,
            output: output)
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
