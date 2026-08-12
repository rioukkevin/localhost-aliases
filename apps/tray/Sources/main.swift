import AppKit

// Entry point. `LSUIElement` in Info.plist already makes this a menu-bar-only app; setting
// the activation policy here means the bare binary in `.build/` behaves the same way (no
// dock icon, no window) when it is run outside the bundle.
let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
