import Foundation

// =============================================================================================
//  The in-app uninstall.
//
//  Two things are tested here, and neither of them removes anything:
//
//    1. THE INVOCATION — that the tray hands teardown.sh everything the script documents,
//       above all LA_WAIT_PID (a running app cannot delete its own bundle) and the app bundle
//       path itself. `Uninstaller.command` is pure; nothing is spawned.
//
//    2. THE REPORT — that a failed step is read back as a failed step and shown, and that the
//       steps AFTER it are still read as having run. That is the whole defect: a teardown that
//       stops at the first failure leaves an app that has already dismantled its own system
//       state and can no longer remove itself. The sequencing itself is enforced in
//       teardown.sh and tested in packages/privileged/test/teardown.test.ts; what is checked
//       here is that the app tells the truth about it instead of reporting "done".
// =============================================================================================

private let resources = "/Applications/LocalhostAliases.app/Contents/Resources"

private func command(waitPid: Int32? = 4242, appBundle: String? = "/Applications/LocalhostAliases.app")
    -> Uninstaller.Command
{
    Uninstaller.command(
        privilegedDir: "\(resources)/privileged",
        configDir: "/Users/dev/.config/localhost-aliases",
        logDir: "/Users/dev/Library/Logs/localhost-aliases",
        appBundle: appBundle,
        forwarder: "\(resources)/forwarder",
        waitPid: waitPid,
        managedIps: ["127.0.0.2", "127.0.0.3"])
}

func runUninstallTests() {
    print("Uninstaller.command() — what the app asks teardown.sh to do")

    let full = command()
    check(full.executable == "/bin/bash", "the shipped script is run by /bin/bash, not by its exec bit")
    check(
        full.arguments == ["\(resources)/privileged/teardown.sh"],
        "and it is the copy INSIDE the bundle — no checkout is involved")
    check(
        full.environment["LA_CONFIG_DIR"] == "/Users/dev/.config/localhost-aliases",
        "the config directory is passed explicitly; as root there is no useful HOME")
    check(
        full.environment["LA_LOG_DIR"] == "/Users/dev/Library/Logs/localhost-aliases",
        "so is the log directory")
    check(
        full.environment["LA_APP_BUNDLE"] == "/Applications/LocalhostAliases.app",
        "the bundle to remove is named, never guessed by the script")
    check(
        full.environment["LA_WAIT_PID"] == "4242",
        "and the app's own pid, because a running app cannot delete its own bundle")
    check(
        full.environment["LA_MANAGED_IPS"] == "127.0.0.2 127.0.0.3",
        "only the loopback addresses this install allocated may be removed from lo0")
    check(
        full.environment["LA_FORWARDER"] == "\(resources)/forwarder",
        "the forwarder path lets root verify the pid before signalling it")

    let noBundle = command(waitPid: nil, appBundle: nil)
    check(
        noBundle.environment["LA_APP_BUNDLE"] == nil && noBundle.environment["LA_WAIT_PID"] == nil,
        "a dev build with no bundle asks for no app removal rather than inventing a path")

    let dry = Uninstaller.command(
        privilegedDir: "\(resources)/privileged", configDir: "/c", logDir: "/l",
        appBundle: nil, forwarder: nil, waitPid: nil, managedIps: nil, dryRun: true)
    check(dry.arguments.contains("--dry-run"), "--dry-run is available and off by default")
    check(
        Uninstaller.command(
            privilegedDir: "/p", configDir: "/c", logDir: "/l", appBundle: nil, forwarder: nil,
            waitPid: 1, managedIps: []
        ).environment["LA_WAIT_PID"] == nil,
        "pid 1 is not a plausible app; it is dropped rather than passed to a rm")

    // -- the bundle path the command carries ------------------------------------------------------

    print("RuntimeLayout.appBundle")
    let bundle = RuntimeLayout.resolve(
        executablePath: "/Applications/LocalhostAliases.app/Contents/MacOS/LocalhostAliases")
    check(
        bundle.appBundle == "/Applications/LocalhostAliases.app",
        "the bundle is derived from Contents/Resources, so ~/Applications works the same way")
    check(
        bundle.teardownScript == "/Applications/LocalhostAliases.app/Contents/Resources/privileged/teardown.sh",
        "and the teardown script sits with the other privileged scripts")
    check(
        RuntimeLayout.resolve(executablePath: "/Users/dev/repo/build/LocalhostAliases").appBundle == nil,
        "a dev build has no bundle to delete, and does not offer to delete the repo")

    // -- reading the report back -------------------------------------------------------------------

    print("Uninstaller.parse() — every step, failures included")

    let clean = Uninstaller.parse(
        """
        ==> Uninstalling Localhost Aliases
        LA_STEP system ok hosts block, lo0 addresses, DNS and the root agent
        LA_STEP ca skipped no rootCA.pem — nothing was ever trusted
        LA_STEP config ok removed /Users/dev/.config/localhost-aliases
        LA_STEP logs ok removed /Users/dev/Library/Logs/localhost-aliases
        LA_STEP app scheduled removed once pid 4242 exits
        LA_RESULT status=ok failed=0 app=scheduled
        """)
    check(clean.outcome == .ok, "an all-clear run reads as ok")
    check(clean.steps.count == 5, "every step is kept, including the skipped one")
    check(clean.app == "scheduled", "and the app's fate is read from the result line")
    check(clean.failures.isEmpty, "a skipped step is not a failure — there was nothing to remove")
    check(
        clean.steps[0].detail == "hosts block, lo0 addresses, DNS and the root agent",
        "the detail keeps its spaces")

    // The exact shape of the reported bug: the step that could not delete a root-owned file,
    // followed by the steps that used to never run.
    let partial = Uninstaller.parse(
        """
        LA_STEP system ok hosts block, lo0 addresses, DNS and the root agent
        LA_STEP ca ok removed AABBCC from login.keychain-db
        LA_STEP config failed could not remove /Users/dev/.config/localhost-aliases: Permission denied
        LA_STEP logs ok removed /Users/dev/Library/Logs/localhost-aliases
        LA_STEP app scheduled removed once pid 4242 exits
        LA_RESULT status=partial failed=1 app=scheduled
        """)
    check(partial.outcome == .partial, "one failed step makes the whole run partial, not failed")
    check(partial.failures.map { $0.name } == ["config"], "and the failure is named")
    check(
        partial.steps.map { $0.name } == ["system", "ca", "config", "logs", "app"],
        "the steps after the failure are still there — they ran")
    check(
        partial.steps.last?.status == .scheduled,
        "including the app removal, which is the step the old uninstall never reached")

    let body = Uninstaller.resultBody(partial)
    check(
        body.contains("Permission denied"),
        "the report shows what actually went wrong, not a generic failure")
    check(
        body.contains("Aliases and settings"),
        "in the user's words rather than the script's step names")
    check(
        body.contains("Every step after a failure still ran"),
        "and says so, because 'partial' otherwise reads as 'stopped'")
    check(
        Uninstaller.resultTitle(partial) == "Uninstalled, but one step failed",
        "the title does not claim a clean uninstall")
    check(
        Uninstaller.resultTitle(clean) == "Localhost Aliases is uninstalled",
        "and does claim one when it is true")

    let cancelled = Uninstaller.parse(
        """
        LA_STEP system cancelled the administrator prompt was dismissed — nothing was removed
        LA_RESULT status=cancelled failed=0 app=kept
        """)
    check(cancelled.outcome == .cancelled, "a dismissed prompt is its own outcome, not a failure")
    check(
        Uninstaller.resultBody(cancelled).contains("still here"),
        "and the user is told plainly that nothing was removed")

    check(
        Uninstaller.parse("").outcome == .unknown,
        "a script that printed nothing is unknown, never assumed successful")
    check(
        Uninstaller.parse("LA_STEP config\nLA_STEP app nonsense x\ngarbage").steps.isEmpty,
        "malformed lines are dropped rather than invented into steps")
    check(
        Uninstaller.resultBody(Uninstaller.parse("")).contains(Paths.trayLogPath),
        "and the user is pointed at the log instead of being left guessing")

    // -- what the user is told BEFORE anything happens ---------------------------------------------

    print("Uninstaller.confirmBody() — say it before doing it")
    let plan = Uninstaller.confirmBody(aliasCount: 3)
    for promise in ["/etc/hosts", "lo0", "login keychain", "~/.config/localhost-aliases", "the app itself"] {
        check(plan.contains(promise), "the confirmation names \(promise) before removing it")
    }
    check(plan.contains("3 aliases are deleted"), "and how much of the user's own data goes with it")
    check(
        Uninstaller.confirmBody(aliasCount: 1).contains("1 alias is deleted"),
        "counted correctly for one")
    check(plan.contains("cannot be undone"), "and that it cannot be undone")
    check(
        Uninstaller.plan.count == 6,
        "the plan lists every step teardown.sh performs — promising less would be dishonest too")
}
