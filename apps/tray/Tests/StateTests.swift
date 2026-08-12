import Foundation
import ServiceManagement

func runServiceStateTests() {
    Check.test("every SMAppService.Status maps to a distinct state") {
        Check.equal(ServiceState(.notRegistered), .notRegistered, "notRegistered")
        Check.equal(ServiceState(.enabled), .enabled, "enabled")
        Check.equal(ServiceState(.requiresApproval), .requiresApproval, "requiresApproval")
        Check.equal(ServiceState(.notFound), .notFound, "notFound")
        Check.isTrue(ServiceState.enabled.isActive, "only enabled is active")
        Check.isTrue(!ServiceState.requiresApproval.isActive, "awaiting approval is not active")
        Check.isTrue(!ServiceState.notFound.isActive, "notFound is not active")
        Check.isTrue(ServiceState.notRegistered != ServiceState.notFound, "notFound is not notRegistered")
    }

    Check.test("requiresApproval tells the user exactly where to go") {
        let text = ServiceState.requiresApproval.explanation(subject: .helper)
        Check.contains(text, "System Settings", "names System Settings")
        Check.contains(text, "Login Items", "names the pane")
        Check.contains(text, "aliases will not resolve", "says what breaks meanwhile")
        Check.isTrue(ServiceState.requiresApproval.needsUserApproval, "flagged for the UI")

        let login = ServiceState.requiresApproval.explanation(subject: .launchAtLogin)
        Check.contains(login, "will not start when you log in", "consequence is per-subject")
    }

    Check.test("notFound and notRegistered read differently and both suggest a fix") {
        let notFound = ServiceState.notFound.explanation(subject: .helper)
        Check.contains(notFound, "could not find", "plain language")
        Check.contains(notFound, "/Applications", "the actual fix")
        Check.contains(notFound, Runtime.helperPlistName, "names the missing piece")

        let notRegistered = ServiceState.notRegistered.explanation(subject: .helper)
        Check.contains(notRegistered, "administrator password once", "sets expectations")
        Check.isTrue(!notRegistered.contains("could not find"), "distinct from notFound")

        Check.contains(ServiceState.notRegistered.summary(subject: .helper), "not installed", "summary")
        Check.contains(ServiceState.enabled.summary(subject: .launchAtLogin), "installed and enabled", "summary")
    }

    Check.test("an unknown status degrades instead of crashing") {
        Check.contains(ServiceState.unknown(99).summary(subject: .helper), "unrecognised", "summary")
        Check.contains(ServiceState.unknown(99).explanation(subject: .helper), "99", "keeps the raw value")
    }
}

func runStatusDecodingTests() {
    let full = """
    {"version":"0.1.0","tld":"local","dashboardPort":7788,"https":true,"aliasCount":3,
     "helper":{"installed":false,"running":false,"reason":"socket missing","installMethod":"bundle","status":null},
     "ca":{"generated":true,"trusted":false,"path":"/x"},
     "commands":{"install":"sudo ./scripts/install.sh","start":"x","trust":"y"}}
    """

    Check.test("a Phase 4 status payload decodes") {
        guard let status = try? JSONDecoder().decode(SystemStatusSummary.self, from: Data(full.utf8)) else {
            Check.isTrue(false, "decode failed")
            return
        }
        Check.equal(status.aliasCount, 3, "aliasCount")
        Check.equal(status.https, true, "https")
        Check.equal(status.installMethod, .bundle, "installMethod")
        Check.equal(status.helperReason, "socket missing", "reason")
        Check.equal(status.installCommand, "sudo ./scripts/install.sh", "copyable command")
        Check.isTrue(status.helperMissing, "helper missing")
        Check.equal(status.helperLine, "Helper: not installed", "status line")
    }

    Check.test("an API without installMethod is treated as a script install") {
        let legacy = #"{"aliasCount":1,"https":false,"helper":{"installed":true,"running":true}}"#
        guard let status = try? JSONDecoder().decode(SystemStatusSummary.self, from: Data(legacy.utf8)) else {
            Check.isTrue(false, "decode failed")
            return
        }
        // Never offer to install a root daemon on a guess.
        Check.equal(status.installMethod, .script, "defaults to script")
        Check.isTrue(!status.helperMissing, "helper is fine")
        Check.equal(status.helperLine, "Helper: running", "status line")
    }

    Check.test("a truncated payload degrades to a safe default") {
        guard let status = try? JSONDecoder().decode(SystemStatusSummary.self, from: Data("{}".utf8)) else {
            Check.isTrue(false, "decode failed")
            return
        }
        Check.equal(status.aliasCount, 0, "aliasCount")
        Check.isTrue(status.helperMissing, "unknown helper counts as missing")
        Check.equal(status.installMethod, .script, "no daemon install offered")
    }

    Check.test("an installed-but-stopped helper says so") {
        let stopped = #"{"helper":{"installed":true,"running":false,"installMethod":"bundle"}}"#
        let status = try! JSONDecoder().decode(SystemStatusSummary.self, from: Data(stopped.utf8))
        Check.equal(status.helperLine, "Helper: installed, not running", "status line")
    }

    Check.test("aliases decode forgivingly") {
        let payload = #"[{"name":"myapp","hostname":"myapp.local","url":"https://myapp.local","port":3000,"status":"up","enabled":true},{"name":"bare"}]"#
        guard let aliases = try? JSONDecoder().decode([Alias].self, from: Data(payload.utf8)) else {
            Check.isTrue(false, "decode failed")
            return
        }
        Check.equal(aliases.count, 2, "count")
        Check.equal(aliases[0].url, "https://myapp.local", "https url is used as-is")
        Check.isTrue(aliases[0].isUp, "status")
        Check.equal(aliases[1].hostname, "bare", "hostname falls back to name")
        Check.equal(aliases[1].status, "unknown", "missing status")
    }
}

func runMenuModelTests() {
    func model(
        installed: Bool,
        method: HelperInstallMethod,
        command: String? = "sudo ./scripts/install.sh",
        service: ServiceState?
    ) -> MenuModel {
        var model = MenuModel()
        model.status = SystemStatusSummary(
            aliasCount: 0,
            https: true,
            helperInstalled: installed,
            helperRunning: installed,
            helperReason: nil,
            installMethod: method,
            installCommand: command
        )
        model.helperService = service
        return model
    }

    Check.test("Install Helper… appears only where it can work") {
        Check.isTrue(
            model(installed: false, method: .bundle, service: .notRegistered).offersHelperInstall,
            "bundle install, helper missing"
        )
        Check.isTrue(
            !model(installed: true, method: .bundle, service: .notRegistered).offersHelperInstall,
            "helper already there"
        )
        Check.isTrue(
            !model(installed: false, method: .script, service: .notRegistered).offersHelperInstall,
            "dev install never offers a daemon"
        )
        Check.isTrue(
            !model(installed: false, method: .bundle, service: nil).offersHelperInstall,
            "no service object means nothing to register"
        )
        Check.isTrue(
            model(installed: false, method: .script, service: nil).offersInstallCommand,
            "dev install offers the copyable command"
        )
        Check.isTrue(
            !model(installed: false, method: .script, command: nil, service: nil).offersInstallCommand,
            "…unless the API did not send one"
        )
        Check.isTrue(!MenuModel().offersHelperInstall, "unknown status offers nothing")
        Check.isTrue(!MenuModel().offersInstallCommand, "unknown status offers nothing")
    }
}

func runTrayStateTests() {
    Check.test("the status line never lies about what is running") {
        Check.equal(TrayState.stopped.statusLine, "Stopped", "stopped")
        Check.equal(TrayState.starting.statusLine, "Starting…", "starting")
        Check.equal(TrayState.running(aliasCount: 1).statusLine, "Running · 1 alias", "singular")
        Check.equal(TrayState.running(aliasCount: 4).statusLine, "Running · 4 aliases", "plural")
        Check.contains(TrayState.error("boom").statusLine, "boom", "error carries the reason")
    }
}
