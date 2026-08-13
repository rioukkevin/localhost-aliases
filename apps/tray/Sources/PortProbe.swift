import Darwin
import Foundation

/// Is something listening on 127.0.0.1:<port>? A non-blocking connect with a short budget.
/// Used only to colour the menu — the dashboard does its own probing.
enum PortProbe {
    static func isOpen(port: Int, timeout: TimeInterval = 0.25) -> Bool {
        guard port > 0, port < 65536 else { return false }
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        var flags = fcntl(fd, F_GETFL, 0)
        flags |= O_NONBLOCK
        _ = fcntl(fd, F_SETFL, flags)

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = UInt32(0x7F00_0001).bigEndian

        let result = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if result == 0 { return true }
        guard errno == EINPROGRESS else { return false }

        var poller = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        guard poll(&poller, 1, Int32(timeout * 1000)) > 0 else { return false }

        var sockError: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &sockError, &length) == 0 else { return false }
        return sockError == 0
    }
}
