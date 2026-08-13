import Foundation

/// Append-only text log. The app has no window, so this file is the only place a user
/// (or a reviewer) can see what happened.
final class Logger {
    private let path: String
    private let queue = DispatchQueue(label: "dev.localhost-aliases.log")
    private let maxBytes = 2 * 1024 * 1024

    init(path: String) {
        self.path = path
        Paths.ensureDirectory((path as NSString).deletingLastPathComponent)
        rotateIfNeeded()
    }

    func log(_ message: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        let line = "\(stamp) \(message)\n"
        queue.async { [path] in
            guard let data = line.data(using: .utf8) else { return }
            if let handle = FileHandle(forWritingAtPath: path) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
            } else {
                FileManager.default.createFile(atPath: path, contents: data)
            }
        }
    }

    /// A file handle positioned at EOF, for a child process's stdout/stderr.
    static func appendHandle(at path: String) -> FileHandle? {
        Paths.ensureDirectory((path as NSString).deletingLastPathComponent)
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        guard let handle = FileHandle(forWritingAtPath: path) else { return nil }
        _ = try? handle.seekToEnd()
        return handle
    }

    private func rotateIfNeeded() {
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
        guard size > maxBytes else { return }
        try? FileManager.default.removeItem(atPath: path + ".1")
        try? FileManager.default.moveItem(atPath: path, toPath: path + ".1")
    }
}
