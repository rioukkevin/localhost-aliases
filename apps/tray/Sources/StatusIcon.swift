import AppKit

/// The menu-bar glyph: a patchbay jack, drawn rather than shipped as an asset.
/// Template images are tinted by macOS, so the three states differ in shape, not colour.
enum StatusIcon {
    enum Kind {
        case live       // jack patched: ring + plug
        case idle       // jack empty: ring only
        case attention  // ring + plug + a mark, for drift waiting on the admin prompt
    }

    static func image(_ kind: Kind) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { _ in
            let ring = NSBezierPath(ovalIn: NSRect(x: 3.5, y: 3.5, width: 11, height: 11))
            ring.lineWidth = 1.4
            NSColor.black.setStroke()
            ring.stroke()

            if kind != .idle {
                NSColor.black.setFill()
                NSBezierPath(ovalIn: NSRect(x: 7, y: 7, width: 4, height: 4)).fill()
            }
            if kind == .attention {
                NSColor.black.setFill()
                NSBezierPath(ovalIn: NSRect(x: 13, y: 13, width: 4.5, height: 4.5)).fill()
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}
