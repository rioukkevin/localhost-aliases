import Foundation
import ServiceManagement

/// The only type in the app that talks to `SMAppService`.
///
/// Two services are managed:
///   * the **privileged helper**, `SMAppService.daemon(plistName:)` — registering it installs a
///     root LaunchDaemon, so it is gated twice: the bundle must actually contain the daemon and
///     its plist (`Runtime.canInstallHelperViaBundle`), and `register()` is only ever reached
///     from the "Install Helper…" menu action.
///   * **launch at login**, `SMAppService.mainApp` — same shape, no privileges.
///
/// Reading `.status` has no side effects; it is the only thing done automatically.
final class ManagedService {
    enum Failure: LocalizedError {
        /// This build cannot register the service at all (checkout build, damaged bundle).
        case unavailable(String)
        /// macOS refused. Carries the OS message verbatim — it is usually the useful part.
        case system(String)

        var errorDescription: String? {
            switch self {
            case .unavailable(let reason): return reason
            case .system(let message): return message
            }
        }
    }

    let subject: ServiceState.Subject
    private let service: SMAppService

    private init(service: SMAppService, subject: ServiceState.Subject) {
        self.service = service
        self.subject = subject
    }

    // MARK: - Factories

    /// The privileged helper, or `nil` when this build has nothing to install.
    ///
    /// `plistName` is the *filename* inside `Contents/Library/LaunchDaemons/`; macOS reads
    /// `BundleProgram` from it to find `Contents/MacOS/la-helper`.
    static func helper(runtime: Runtime = .current) -> ManagedService? {
        guard runtime.canInstallHelperViaBundle else { return nil }
        return ManagedService(
            service: SMAppService.daemon(plistName: Runtime.helperPlistName),
            subject: .helper
        )
    }

    /// Launch at login for this app. `nil` outside a bundle — a loose binary cannot be a
    /// login item.
    static func launchAtLogin(runtime: Runtime = .current) -> ManagedService? {
        guard runtime.mode == .bundle else { return nil }
        return ManagedService(service: SMAppService.mainApp, subject: .launchAtLogin)
    }

    // MARK: - State (side-effect free)

    var state: ServiceState { ServiceState(service.status) }

    // MARK: - Mutation (user-initiated only)

    /// Installs the service. For the helper this raises the one administrator prompt and
    /// creates a root daemon — never call it outside an explicit user action.
    func register() throws {
        do {
            try service.register()
        } catch let error as NSError {
            // Already registered is not a failure the user needs to see as one.
            if error.domain == NSOSStatusErrorDomain && error.code == 1 { return }
            throw Failure.system(Self.message(for: error))
        }
    }

    /// Removes the service. Unregistering the helper asks for the administrator password too.
    func unregister() throws {
        do {
            try service.unregister()
        } catch let error as NSError {
            throw Failure.system(Self.message(for: error))
        }
    }

    /// Opens System Settings on the pane that owns approval. Pure UI, no privileges.
    static func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    /// macOS returns terse errors here; add the two that users actually hit.
    private static func message(for error: NSError) -> String {
        switch (error.domain, error.code) {
        case (NSPOSIXErrorDomain, 1):
            return "macOS denied the request (operation not permitted). The app must be signed and installed in /Applications."
        case (NSCocoaErrorDomain, NSFileNoSuchFileError):
            return "macOS could not find the service definition inside the app bundle."
        default:
            return error.localizedDescription
        }
    }
}
