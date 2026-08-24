import Foundation

// =============================================================================================
//  The in-app uninstall, from the tray's side.
//
//  It owns NO teardown logic. Everything the uninstall *is* lives in one shell script that is
//  shipped inside the bundle — Contents/Resources/privileged/teardown.sh — and `make uninstall`
//  runs that same file. A second implementation here would drift from it the first time either
//  was fixed, and the one that matters is the one on the user's machine, which has no checkout
//  next to it.
//
//  This file builds the invocation, parses the report the script prints, and turns both into
//  sentences a user can read before and after. It runs nothing: the Process lives in
//  PrivilegedApply.swift, the file the test target deliberately cannot link, so every decision
//  below is testable with no chance of a password dialog or a deleted app.
// =============================================================================================

enum Uninstaller {
    // MARK: - What the user is told BEFORE anything happens

    /// The confirmation's body. Every line is something that is actually removed, in the order
    /// the script removes it. If a step is added to teardown.sh it belongs here too — promising
    /// less than you do is as dishonest as promising more.
    static let plan: [String] = [
        "the managed block in /etc/hosts (every line outside it is kept, byte for byte)",
        "the 127.0.0.x loopback addresses this app added to lo0",
        "the root agent, stopped, and the DNS cache, flushed",
        "the local CA in your login keychain, matched by fingerprint",
        "~/.config/localhost-aliases — your aliases and settings",
        "the app itself, once it has quit",
    ]

    static let confirmTitle = "Remove Localhost Aliases and everything it changed?"

    static func confirmBody(aliasCount: Int) -> String {
        let aliases =
            aliasCount == 1 ? "Your 1 alias is deleted." : "Your \(aliasCount) aliases are deleted."
        return """
            This removes, in order:

            \(plan.map { "•  \($0)" }.joined(separator: "\n"))

            \(aliases) Your projects and dev servers are not touched. macOS asks for your \
            administrator password once, for the first step only. This cannot be undone.
            """
    }

    // MARK: - The invocation

    struct Command: Equatable {
        let executable: String
        let arguments: [String]
        let environment: [String: String]
    }

    /// `/bin/bash <Resources>/privileged/teardown.sh`, with everything the script documents.
    ///
    /// `waitPid` is this process. A running app cannot reliably delete its own bundle, so the
    /// script hands the bundle to a detached helper that waits for this pid to be gone first.
    /// Passing nil means "remove it now", which is what `make uninstall` does with the app quit.
    static func command(
        privilegedDir: String,
        configDir: String,
        logDir: String,
        appBundle: String?,
        forwarder: String?,
        waitPid: Int32?,
        managedIps: [String]?,
        dryRun: Bool = false
    ) -> Command {
        var environment: [String: String] = [
            "LA_CONFIG_DIR": configDir,
            "LA_LOG_DIR": logDir,
        ]
        if let appBundle, !appBundle.isEmpty { environment["LA_APP_BUNDLE"] = appBundle }
        if let forwarder, !forwarder.isEmpty { environment["LA_FORWARDER"] = forwarder }
        if let waitPid, waitPid > 1 { environment["LA_WAIT_PID"] = String(waitPid) }
        if let managedIps, !managedIps.isEmpty {
            environment["LA_MANAGED_IPS"] = managedIps.joined(separator: " ")
        }
        return Command(
            executable: "/bin/bash",
            arguments: ["\(privilegedDir)/teardown.sh"] + (dryRun ? ["--dry-run"] : []),
            environment: environment)
    }

    // MARK: - The report the script prints

    enum StepStatus: String, Equatable {
        case ok
        case failed
        case skipped
        case scheduled
        case cancelled
        case dryRun = "dry-run"

        /// The mark in the report. Skipped is not a failure — it means there was nothing there.
        var mark: String {
            switch self {
            case .ok: return "✓"
            case .failed: return "✗"
            case .skipped: return "–"
            case .scheduled: return "⏳"
            case .cancelled: return "✗"
            case .dryRun: return "·"
            }
        }
    }

    struct Step: Equatable {
        let name: String
        let status: StepStatus
        let detail: String

        /// What that step is, in the user's terms rather than the script's.
        var title: String {
            switch name {
            case "system": return "System changes (/etc/hosts, lo0, DNS, root agent)"
            case "ca": return "Local CA in the login keychain"
            case "config": return "Aliases and settings"
            case "logs": return "Logs"
            case "app": return "The app itself"
            default: return name
            }
        }
    }

    enum Outcome: String, Equatable {
        /// Every step did what it said.
        case ok
        /// At least one step failed — and every step after it still ran.
        case partial
        /// The password prompt was dismissed. Nothing was removed.
        case cancelled
        /// The script produced no LA_RESULT line at all (it was killed, or never started).
        case unknown
    }

    struct Report: Equatable {
        let outcome: Outcome
        let steps: [Step]
        /// Whether the bundle is gone, going, or still here — the one fact a user checks.
        let app: String

        var failures: [Step] { steps.filter { $0.status == .failed } }
    }

    /// Parses `LA_STEP <name> <status> <detail…>` and the final `LA_RESULT status=… app=…`.
    ///
    /// Tolerant by design: unparseable output must degrade to `.unknown` with whatever steps
    /// were understood, never throw away the run's own account of itself.
    static func parse(_ output: String) -> Report {
        var steps: [Step] = []
        var outcome: Outcome = .unknown
        var app = "unknown"

        for raw in output.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("LA_STEP ") {
                let fields = line.dropFirst("LA_STEP ".count).split(
                    separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
                guard fields.count >= 2, let status = StepStatus(rawValue: String(fields[1]))
                else { continue }
                steps.append(
                    Step(
                        name: String(fields[0]), status: status,
                        detail: fields.count > 2 ? String(fields[2]) : ""))
            } else if line.hasPrefix("LA_RESULT ") {
                for token in line.dropFirst("LA_RESULT ".count).split(separator: " ") {
                    let pair = token.split(separator: "=", maxSplits: 1)
                    guard pair.count == 2 else { continue }
                    if pair[0] == "status" { outcome = Outcome(rawValue: String(pair[1])) ?? .unknown }
                    if pair[0] == "app" { app = String(pair[1]) }
                }
            }
        }
        return Report(outcome: outcome, steps: steps, app: app)
    }

    // MARK: - What the user is told AFTERWARDS

    static func resultTitle(_ report: Report) -> String {
        switch report.outcome {
        case .ok: return "Localhost Aliases is uninstalled"
        case .partial:
            return report.failures.count == 1
                ? "Uninstalled, but one step failed" : "Uninstalled, but \(report.failures.count) steps failed"
        case .cancelled: return "Nothing was removed"
        case .unknown: return "The uninstall did not report back"
        }
    }

    /// Every step and what became of it — including the ones that failed. A teardown that
    /// hides its failures leaves the user believing their machine is clean when it is not.
    static func resultBody(_ report: Report) -> String {
        var lines: [String] = []
        switch report.outcome {
        case .cancelled:
            lines.append(
                "The administrator prompt was dismissed, so the uninstall stopped before it "
                    + "removed anything. Your aliases, the /etc/hosts block and the app are all "
                    + "still here.")
        case .unknown:
            lines.append(
                "The uninstaller did not print a result, so what it managed to do is unknown. "
                    + "Check \(Paths.trayLogPath), then run it again — it is safe to repeat.")
        case .ok, .partial:
            lines.append(contentsOf: report.steps.map { "\($0.status.mark)  \($0.title) — \(detailFor($0))" })
        }

        if report.outcome == .partial {
            lines.append("")
            lines.append(
                "Every step after a failure still ran — a half-finished uninstall is worse "
                    + "than a reported one. Running it again is safe and picks up what is left.")
        }
        if report.app == "scheduled" {
            lines.append("")
            lines.append("The app removes itself the moment it quits, which is now.")
        }
        return lines.joined(separator: "\n")
    }

    private static func detailFor(_ step: Step) -> String {
        step.detail.isEmpty ? step.status.rawValue : step.detail
    }
}
