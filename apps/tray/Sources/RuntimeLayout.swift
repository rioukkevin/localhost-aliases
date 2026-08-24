import Foundation

/// Where the runtime pieces live. Mirrors `runtimeLayout()` in paths.ts.
///
/// Bundle mode is detected from the executable path containing `.app/Contents/` — the same
/// test paths.ts applies to `process.execPath`. Nothing here may assume a git checkout.
struct RuntimeLayout {
    enum Mode: String {
        case bundle
        case dev
    }

    let mode: Mode
    /// Contents/Resources in bundle mode, the repo root in dev mode.
    let root: String
    let bun: String
    let dashboardDir: String
    let forwarder: String
    let applyScript: String
    let mcpEntry: String

    /// Directory holding apply.sh (and, when shipped, prompt.ts).
    var privilegedDir: String { (applyScript as NSString).deletingLastPathComponent }
    var promptScript: String { "\(privilegedDir)/prompt.ts" }
    /// The whole uninstall, shipped so it works with no checkout on the machine.
    var teardownScript: String { "\(privilegedDir)/teardown.sh" }

    /// The .app to remove on uninstall — `root` is Contents/Resources, so the bundle is two
    /// levels up. Nil in dev mode: there is no bundle, and "delete the repo" is not on offer.
    var appBundle: String? {
        guard mode == .bundle else { return nil }
        let contents = (root as NSString).deletingLastPathComponent
        let bundle = (contents as NSString).deletingLastPathComponent
        return bundle.hasSuffix(".app") ? bundle : nil
    }

    /// `executablePath` is injectable so the bundle/dev split can be tested without a bundle.
    static func resolve(
        executablePath: String = Bundle.main.executablePath
            ?? ProcessInfo.processInfo.arguments.first ?? ""
    ) -> RuntimeLayout {
        let exec = executablePath
        let marker = ".app/Contents/"
        let override = Paths.env("LA_RUNTIME_ROOT")

        if override == nil, let range = exec.range(of: marker) {
            let resources = String(exec[exec.startIndex..<range.upperBound]) + "Resources"
            return RuntimeLayout(
                mode: .bundle,
                root: resources,
                bun: "\(resources)/bin/bun",
                dashboardDir: "\(resources)/dashboard",
                forwarder: "\(resources)/forwarder",
                applyScript: "\(resources)/privileged/apply.sh",
                mcpEntry: "\(resources)/mcp")
        }

        let root = override ?? Paths.env("LA_REPO_ROOT") ?? FileManager.default.currentDirectoryPath
        return RuntimeLayout(
            mode: .dev,
            root: root,
            bun: Paths.env("LA_BUN") ?? Executables.findBun(),
            dashboardDir: "\(root)/packages/dashboard",
            forwarder: "\(root)/packages/forwarder/src/index.ts",
            applyScript: "\(root)/packages/privileged/apply.sh",
            mcpEntry: "\(root)/packages/mcp/src/index.ts")
    }
}

/// A GUI app inherits almost no PATH, so `bun` has to be located by hand in dev mode.
enum Executables {
    static func findBun() -> String {
        let candidates = [
            "\(NSHomeDirectory())/.bun/bin/bun",
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
        ]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        return "bun"  // last resort: only works when PATH already has it
    }
}
