import Foundation

/// Read-only view of `config.json`. The tray never writes it — the dashboard owns that file.
/// Shapes follow `Config` / `Alias` in packages/core/src/types.ts.
struct AliasEntry: Decodable {
    let id: String
    let name: String
    let port: Int
    let ip: String
    let enabled: Bool
    let reserved: Bool
    let description: String?

    func hostname(tld: String) -> String { "\(name).\(tld)" }

    /// Always http. The forwarder splices raw bytes, so TLS cannot be terminated for
    /// project aliases (docs/V2.md). Matches `urlFor` in core.
    func url(tld: String) -> String { "http://\(hostname(tld: tld))" }
}

struct AppConfig: Decodable {
    let tld: String
    let dashboardPort: Int
    let https: Bool
    let aliases: [AliasEntry]

    static let fallback = AppConfig(tld: "local", dashboardPort: 7788, https: false, aliases: [])

    static let reservedName = "index"

    /// Project aliases, in file order, excluding the reserved dashboard alias.
    var projectAliases: [AliasEntry] { aliases.filter { !$0.reserved } }

    var reservedAlias: AliasEntry? { aliases.first { $0.reserved } }

    /// `index.local` — the dashboard's own alias.
    var dashboardHostname: String { "\(reservedAlias?.name ?? Self.reservedName).\(tld)" }

    var loopbackDashboardURL: String { "http://127.0.0.1:\(dashboardPort)" }

    static func load() -> AppConfig {
        guard let data = FileManager.default.contents(atPath: Paths.configPath) else {
            return .fallback
        }
        let decoder = JSONDecoder()
        guard let config = try? decoder.decode(AppConfig.self, from: data) else { return .fallback }
        return config
    }
}
