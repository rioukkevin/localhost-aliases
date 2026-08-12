import Foundation

/// Append-only log file handed to the child process as stdout/stderr.
///
/// Owns nothing but the file descriptor: rotation is size-based and happens at open time,
/// which is the only moment no child is holding the fd.
enum LogFile {
    /// Rotate once the log passes this size, keeping a single `.1` generation.
    static let rotateAtBytes: UInt64 = 5 * 1024 * 1024

    /// Opens `url` for appending, creating parent directories and rotating when oversized.
    /// Returns a raw fd owned by the caller, or `nil` when the path is not writable.
    static func openForAppending(_ url: URL) -> Int32 {
        let fs = FileManager.default
        try? fs.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        rotateIfNeeded(url)
        return open(url.path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
    }

    private static func rotateIfNeeded(_ url: URL) {
        let fs = FileManager.default
        guard let size = (try? fs.attributesOfItem(atPath: url.path)[.size]) as? UInt64,
              size > rotateAtBytes else { return }
        let previous = url.appendingPathExtension("1")
        try? fs.removeItem(at: previous)
        try? fs.moveItem(at: url, to: previous)
    }

    /// Writes one supervisor line (a spawn/exit marker) so the log explains its own gaps.
    static func writeLine(_ fd: Int32, _ message: String) {
        guard fd >= 0 else { return }
        let stamp = ISO8601DateFormatter().string(from: Date())
        let line = "[tray \(stamp)] \(message)\n"
        _ = line.withCString { pointer in
            write(fd, pointer, strlen(pointer))
        }
    }
}
