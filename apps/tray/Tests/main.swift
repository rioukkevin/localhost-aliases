import Foundation

// Pure-logic tests for the tray: layout resolution, service-status wording, API decoding and
// menu-visibility rules. Nothing here touches AppKit, the network, or SMAppService's mutating
// API — `register()` is never called, by construction (see RuntimeTests).
runRuntimeTests()
runServiceStateTests()
runStatusDecodingTests()
runMenuModelTests()
runTrayStateTests()
exit(Check.summarise())
