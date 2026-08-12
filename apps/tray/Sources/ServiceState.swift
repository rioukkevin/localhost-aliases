import Foundation
import ServiceManagement

/// `SMAppService.Status`, restated so it can be reasoned about (and tested) without the
/// framework, and rendered in language a user can act on.
///
/// The mapping matters more than it looks: `.requiresApproval` is the state macOS puts a
/// freshly registered service in until the user flips its switch in System Settings, and an
/// app that just says "requiresApproval" — or worse, says nothing — looks broken.
enum ServiceState: Equatable {
    /// Never registered, or unregistered again. The normal first-run state.
    case notRegistered
    /// Registered and allowed to run.
    case enabled
    /// Registered, but macOS is waiting for the user to approve it in Login Items.
    case requiresApproval
    /// macOS cannot find the service: the plist is missing from the bundle, or the app is
    /// running from a location (Downloads quarantine, a checkout) it will not accept.
    case notFound
    /// A status this build predates.
    case unknown(Int)

    init(_ status: SMAppService.Status) {
        switch status {
        case .notRegistered: self = .notRegistered
        case .enabled: self = .enabled
        case .requiresApproval: self = .requiresApproval
        case .notFound: self = .notFound
        @unknown default: self = .unknown(status.rawValue)
        }
    }

    /// True only when the service is actually able to run right now.
    var isActive: Bool { self == .enabled }

    /// True when the user has to do something in System Settings before it works.
    var needsUserApproval: Bool { self == .requiresApproval }

    /// One short line for a menu item's subtitle or tooltip.
    func summary(subject: Subject) -> String {
        switch self {
        case .notRegistered: return "\(subject.noun) is not installed"
        case .enabled: return "\(subject.noun) is installed and enabled"
        case .requiresApproval: return "\(subject.noun) needs your approval in System Settings"
        case .notFound: return "\(subject.noun) could not be found by macOS"
        case .unknown(let raw): return "\(subject.noun) is in an unrecognised state (\(raw))"
        }
    }

    /// The full explanation, including what to do next. Shown in the alert after an action.
    func explanation(subject: Subject) -> String {
        switch self {
        case .notRegistered:
            return subject.notRegisteredAdvice
        case .enabled:
            return subject.enabledAdvice
        case .requiresApproval:
            return """
                macOS is waiting for you to approve it.

                Open System Settings › General › Login Items & Extensions, find \
                “Localhost Aliases”, and turn it on. Until you do, \(subject.consequence)
                """
        case .notFound:
            return """
                macOS could not find \(subject.noun.lowercased()).

                This usually means the app is not installed in /Applications, or this build is \
                missing \(subject.missingPiece). Move Localhost Aliases to /Applications and \
                try again.
                """
        case .unknown(let raw):
            return "macOS reported status \(raw), which this version of the app does not know about."
        }
    }

    /// The two things this app registers, and the wording each one needs.
    enum Subject {
        case helper
        case launchAtLogin

        var noun: String {
            switch self {
            case .helper: return "The privileged helper"
            case .launchAtLogin: return "Launch at Login"
            }
        }

        var consequence: String {
            switch self {
            case .helper: return "your aliases will not resolve."
            case .launchAtLogin: return "Localhost Aliases will not start when you log in."
            }
        }

        var missingPiece: String {
            switch self {
            case .helper: return "Contents/Library/LaunchDaemons/\(Runtime.helperPlistName)"
            case .launchAtLogin: return "a valid bundle identifier"
            }
        }

        var notRegisteredAdvice: String {
            switch self {
            case .helper:
                return """
                    The helper owns ports 80 and 443 and the managed block in /etc/hosts, so it \
                    has to run as root. Installing it asks for your administrator password once, \
                    then it appears in System Settings › Login Items where you can disable it at \
                    any time.
                    """
            case .launchAtLogin:
                return "Localhost Aliases will not start automatically when you log in."
            }
        }

        var enabledAdvice: String {
            switch self {
            case .helper:
                return "The helper is installed and running as a system daemon."
            case .launchAtLogin:
                return "Localhost Aliases will start automatically when you log in."
            }
        }
    }
}
