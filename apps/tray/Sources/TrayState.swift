import AppKit

/// What the menu bar is currently telling the user. Derived by `AppDelegate` from the
/// supervised process plus the health poll; consumed by `StatusIcon` and `StatusMenu`.
enum TrayState {
    /// No server, and none wanted.
    case stopped
    /// A child is up but `/api/health` has not answered yet.
    case starting
    /// The API answered.
    case running(aliasCount: Int)
    /// Cannot spawn, or the server keeps dying.
    case error(String)

    /// First line of the menu.
    var statusLine: String {
        switch self {
        case .stopped:
            return "Stopped"
        case .starting:
            return "Starting…"
        case .running(let count):
            return "Running · \(count) alias\(count == 1 ? "" : "es")"
        case .error(let reason):
            return "Error · \(reason)"
        }
    }

    var accessibilityDescription: String {
        switch self {
        case .stopped: return "Localhost Aliases: server stopped"
        case .starting: return "Localhost Aliases: server starting"
        case .running(let count): return "Localhost Aliases: running, \(count) aliases"
        case .error(let reason): return "Localhost Aliases: error, \(reason)"
        }
    }

    /// Each state gets its own glyph — shape, not colour, is what survives every menu bar
    /// appearance (light, dark, highlighted, reduced transparency).
    var symbolName: String {
        switch self {
        case .stopped: return "pause.circle"
        case .starting: return "arrow.triangle.2.circlepath"
        case .running: return "point.3.connected.trianglepath.dotted"
        case .error: return "exclamationmark.triangle.fill"
        }
    }

    /// `nil` means "render as a template image", which is the correct default in a menu bar.
    /// Only the error state opts out, because an alert is worth breaking the rule for; the
    /// colour used is a dynamic system colour so it stays legible in both appearances.
    var tint: NSColor? {
        switch self {
        case .error: return .systemRed
        case .stopped, .starting, .running: return nil
        }
    }
}
