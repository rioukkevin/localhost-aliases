import Foundation

/// A 30-line test harness. XCTest would need SwiftPM or Xcode; this target is one `swiftc`
/// invocation and stays that way.
enum Check {
    nonisolated(unsafe) static var failures: [String] = []
    nonisolated(unsafe) static var checks = 0
    nonisolated(unsafe) static var currentCase = ""

    static func test(_ name: String, _ body: () -> Void) {
        currentCase = name
        body()
    }

    static func equal<T: Equatable>(_ actual: T, _ expected: T, _ what: String) {
        checks += 1
        guard actual != expected else { return }
        failures.append("\(currentCase): \(what)\n      expected: \(expected)\n      actual:   \(actual)")
    }

    static func isTrue(_ value: Bool, _ what: String) {
        checks += 1
        if !value { failures.append("\(currentCase): \(what) — expected true") }
    }

    static func contains(_ haystack: String, _ needle: String, _ what: String) {
        checks += 1
        if !haystack.contains(needle) {
            failures.append("\(currentCase): \(what) — “\(needle)” missing from “\(haystack)”")
        }
    }

    static func summarise() -> Int32 {
        if failures.isEmpty {
            print("ok — \(checks) checks passed")
            return 0
        }
        print("FAILED — \(failures.count) of \(checks) checks")
        for failure in failures { print("  ✗ \(failure)") }
        return 1
    }
}

/// A filesystem that exists only in the test.
func probe(files: Set<String>, executables: Set<String> = []) -> FileProbe {
    FileProbe(
        exists: { files.contains($0) || executables.contains($0) },
        isExecutable: { executables.contains($0) }
    )
}
