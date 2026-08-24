import Foundation
import ServiceManagement

// =============================================================================================
//  THE ONLY PLACE IN THIS APP THAT REGISTERS A LOGIN ITEM.
//
//  Two calls exist in this file and nowhere else:
//
//      SMAppService.mainApp.register()      — line marked (1) below
//      SMAppService.mainApp.unregister()    — line marked (2) below
//
//  Neither runs on its own. There is no timer, no launch-time call and no retry loop pointing
//  at them. `apply(_:)` is reached from exactly one place — LoginItemWatcher.handle — which
//  needs a fresh, never-before-seen request id written by an explicit click in the dashboard's
//  settings drawer. Reading the status is separate, side-effect free, and is what every other
//  code path uses.
//
//  `SMAppService.mainApp` is a LOGIN ITEM, not a daemon: no plist is installed, nothing lands
//  in /Library, and unregistering removes it. docs/V2.md's "no SMAppService daemon" still
//  holds — the root agent is still started by the one admin prompt, never by launchd.
//
//  Set LA_NO_LOGIN_ITEM=1 to hard-disable both calls while developing.
// =============================================================================================

enum LoginItemService {
    /// Kill switch, checked immediately before either call. Reading the status stays allowed:
    /// it changes nothing and telling the truth is the point.
    static var isDisabled: Bool { Paths.env("LA_NO_LOGIN_ITEM") != nil }

    /// The real `SMAppService.Status`, mapped one-to-one. No optimistic boolean anywhere:
    /// `.requiresApproval` stays `.requiresApproval` all the way to the UI.
    static func currentState() -> LoginItemState {
        switch SMAppService.mainApp.status {
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notRegistered: return .notRegistered
        case .notFound: return .notFound
        @unknown default: return .unknown
        }
    }

    /// Enable or disable, then report what macOS says AFTERWARDS — never what we asked for.
    /// A `register()` that succeeds usually lands on `.requiresApproval` the first time, and
    /// the caller must be able to see that.
    ///
    /// Runs off the main thread (both calls do IPC with `launchservicesd`) and calls back on it.
    static func apply(_ action: LoginItemAction, log: Logger, completion: @escaping (LoginItemState) -> Void) {
        guard action != .refresh else {
            completion(currentState())
            return
        }
        guard !isDisabled else {
            log.log("login-item: refused — LA_NO_LOGIN_ITEM is set")
            completion(currentState())
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                switch action {
                case .enable:
                    try SMAppService.mainApp.register()  // (1) the only register() in the app
                case .disable:
                    try SMAppService.mainApp.unregister()  // (2) the only unregister() in the app
                case .refresh:
                    break
                }
                log.log("login-item: \(action.rawValue) succeeded")
            } catch {
                // A failure is not fatal and not hidden: the status read below is still the
                // truth, and the dashboard renders it with the reason.
                log.log("login-item: \(action.rawValue) failed — \(error.localizedDescription)")
            }
            let state = currentState()
            DispatchQueue.main.async { completion(state) }
        }
    }
}
