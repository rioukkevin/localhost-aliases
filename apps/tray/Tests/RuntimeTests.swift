import Foundation

private let bundleExecutable = "/Applications/LocalhostAliases.app/Contents/MacOS/LocalhostAliases"
private let contents = "/Applications/LocalhostAliases.app/Contents"

func runRuntimeTests() {
    Check.test("contentsDirectory finds the .app/Contents ancestor") {
        Check.equal(Runtime.contentsDirectory(forExecutable: bundleExecutable), contents, "installed app")
        Check.equal(
            Runtime.contentsDirectory(forExecutable: "/repo/apps/tray/.build/LocalhostAliases"),
            nil,
            "bare binary is not a bundle"
        )
        // A directory that merely ends in .app is not a bundle unless Contents follows.
        Check.equal(
            Runtime.contentsDirectory(forExecutable: "/repo/weird.app/bin/tool"),
            nil,
            ".app without Contents"
        )
    }

    Check.test("mode follows the frozen detection rule") {
        let installed = Runtime(executablePath: bundleExecutable, environment: [:], probe: probe(files: []))
        Check.equal(installed.mode, .bundle, "executable inside .app/Contents")

        let checkout = Runtime(
            executablePath: "/repo/apps/tray/.build/LocalhostAliases",
            environment: [:],
            probe: probe(files: [])
        )
        Check.equal(checkout.mode, .dev, "loose binary")

        let forced = Runtime(executablePath: bundleExecutable, environment: ["LA_RUNTIME": "dev"], probe: probe(files: []))
        Check.equal(forced.mode, .dev, "LA_RUNTIME=dev wins over the path marker")
    }

    Check.test("bundle mode runs the embedded bun against the embedded standalone build") {
        let runtime = Runtime(
            executablePath: bundleExecutable,
            environment: [:],
            probe: probe(
                files: [contents + "/Resources/web/server.js"],
                executables: [contents + "/Resources/bin/bun"]
            )
        )
        guard case .success(let launch) = runtime.resolveWebServer(dashboardPort: 7788) else {
            Check.isTrue(false, "expected a resolved launch")
            return
        }
        Check.equal(launch.mode, .bundle, "mode")
        Check.equal(launch.executable, contents + "/Resources/bin/bun", "embedded bun")
        Check.equal(launch.arguments, ["--bun", contents + "/Resources/web/server.js"], "arguments")
        Check.equal(launch.workingDirectory, contents + "/Resources/web", "cwd")
        Check.equal(launch.environment["PORT"], "7788", "PORT for next standalone")
        Check.equal(launch.environment["HOSTNAME"], "127.0.0.1", "loopback only")
        Check.equal(launch.environment["LA_DASHBOARD_PORT"], "7788", "core reads this")
    }

    Check.test("a damaged bundle with no checkout reports the bundle problem") {
        let runtime = Runtime(
            executablePath: bundleExecutable,
            environment: [:],
            probe: probe(files: [], executables: [])
        )
        guard case .failure(let reason) = runtime.resolveWebServer(dashboardPort: 7788) else {
            Check.isTrue(false, "expected failure")
            return
        }
        Check.contains(reason, "Damaged app", "names the real problem")
    }

    Check.test("a tray-only bundle beside a checkout falls back to the dev layout") {
        // Exactly what `make app` produces: no Resources payload, but a checkout above it.
        let runtime = Runtime(
            executablePath: "/repo/apps/tray/LocalhostAliases.app/Contents/MacOS/LocalhostAliases",
            environment: ["LA_BUN": "/opt/homebrew/bin/bun", "PATH": ""],
            probe: probe(
                files: ["/repo/packages/web/package.json"],
                executables: ["/opt/homebrew/bin/bun"]
            )
        )
        guard case .success(let launch) = runtime.resolveWebServer(dashboardPort: 7788) else {
            Check.isTrue(false, "expected the dev fallback")
            return
        }
        Check.equal(launch.mode, .dev, "fell back")
        Check.equal(launch.arguments, ["run", "--cwd", "/repo/packages/web", "start"], "package script keeps --bun")
    }

    Check.test("dev mode prefers LA_INSTALL_ROOT and needs a bun") {
        let withBun = Runtime(
            executablePath: "/repo/apps/tray/.build/LocalhostAliases",
            environment: ["LA_INSTALL_ROOT": "/opt/la", "LA_BUN": "/custom/bun", "PATH": ""],
            probe: probe(files: ["/opt/la/packages/web/package.json"], executables: ["/custom/bun"])
        )
        guard case .success(let launch) = withBun.resolveWebServer(dashboardPort: 9000) else {
            Check.isTrue(false, "expected success")
            return
        }
        Check.equal(launch.executable, "/custom/bun", "LA_BUN wins")
        Check.equal(launch.arguments, ["run", "--cwd", "/opt/la/packages/web", "start"], "install root wins")
        Check.equal(launch.environment["LA_DASHBOARD_PORT"], "9000", "port is threaded through")

        let noBun = Runtime(
            executablePath: "/repo/apps/tray/.build/LocalhostAliases",
            environment: ["LA_INSTALL_ROOT": "/opt/la", "PATH": ""],
            probe: probe(files: ["/opt/la/packages/web/package.json"])
        )
        guard case .failure(let reason) = noBun.resolveWebServer(dashboardPort: 7788) else {
            Check.isTrue(false, "expected failure without bun")
            return
        }
        Check.contains(reason, "bun not found", "actionable message")

        let noRoot = Runtime(
            executablePath: "/repo/apps/tray/.build/LocalhostAliases",
            environment: ["PATH": ""],
            probe: probe(files: [], executables: ["/opt/homebrew/bin/bun"])
        )
        guard case .failure(let missing) = noRoot.resolveWebServer(dashboardPort: 7788) else {
            Check.isTrue(false, "expected failure without a runtime")
            return
        }
        Check.contains(missing, "Runtime not found", "actionable message")
    }

    Check.test("helper installation is gated on a bundle that really carries the daemon") {
        let plist = contents + "/Library/LaunchDaemons/" + Runtime.helperPlistName
        let helper = contents + "/MacOS/la-helper"

        let complete = Runtime(executablePath: bundleExecutable, environment: [:], probe: probe(files: [plist, helper]))
        Check.isTrue(complete.canInstallHelperViaBundle, "complete bundle can install")
        Check.equal(complete.helperPlistPath, plist, "plist path")

        let noPlist = Runtime(executablePath: bundleExecutable, environment: [:], probe: probe(files: [helper]))
        Check.isTrue(!noPlist.canInstallHelperViaBundle, "missing plist blocks installation")

        let noDaemon = Runtime(executablePath: bundleExecutable, environment: [:], probe: probe(files: [plist]))
        Check.isTrue(!noDaemon.canInstallHelperViaBundle, "missing la-helper blocks installation")

        let checkout = Runtime(
            executablePath: "/repo/apps/tray/.build/LocalhostAliases",
            environment: [:],
            probe: probe(files: [plist, helper])
        )
        Check.isTrue(!checkout.canInstallHelperViaBundle, "a checkout build can never register a daemon")
        // The gate is what makes `ManagedService.helper()` unavailable, so nothing can call
        // register() from a development build.
        Check.isTrue(ManagedService.helper(runtime: checkout) == nil, "no service object outside a bundle")
    }
}
