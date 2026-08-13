import AppKit

// LSUIElement in Info.plist keeps us out of the Dock; .accessory keeps us out of it even when
// the binary is run directly. The app never opens a window — the dashboard is a browser tab.
let application = NSApplication.shared
application.setActivationPolicy(.accessory)

let delegate = AppDelegate()
application.delegate = delegate
application.run()
