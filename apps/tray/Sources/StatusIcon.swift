import AppKit

/// Builds the images the menu bar shows.
///
/// Menu bar rule: an untinted symbol is marked `isTemplate`, so AppKit inverts it for light
/// and dark menu bars and for the highlighted (menu open) state. A tinted symbol cannot be a
/// template, so it is drawn through a drawing handler — AppKit re-runs the handler under the
/// current appearance, which is what lets a dynamic `NSColor` resolve correctly in both.
enum StatusIcon {
    private static let pointSize: CGFloat = 15

    static func image(for state: TrayState) -> NSImage {
        let configuration = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .regular)
        guard let symbol = NSImage(
            systemSymbolName: state.symbolName,
            accessibilityDescription: state.accessibilityDescription
        )?.withSymbolConfiguration(configuration) else {
            return dot(color: state.tint ?? .labelColor, diameter: pointSize * 0.6)
        }

        guard let tint = state.tint else {
            symbol.isTemplate = true
            return symbol
        }
        return tinted(symbol, with: tint, accessibilityDescription: state.accessibilityDescription)
    }

    /// Per-alias liveness dot shown next to each hostname in the menu.
    static func aliasDot(status: String) -> NSImage {
        let color: NSColor
        switch status {
        case "up": color = .systemGreen
        case "down": color = .systemOrange
        default: color = .tertiaryLabelColor
        }
        return dot(color: color, diameter: 8)
    }

    // MARK: - Private

    private static func tinted(
        _ image: NSImage,
        with color: NSColor,
        accessibilityDescription: String
    ) -> NSImage {
        let result = NSImage(size: image.size, flipped: false) { rect in
            image.draw(in: rect)
            color.set()
            rect.fill(using: .sourceAtop)
            return true
        }
        result.isTemplate = false
        result.accessibilityDescription = accessibilityDescription
        return result
    }

    private static func dot(color: NSColor, diameter: CGFloat) -> NSImage {
        let image = NSImage(size: NSSize(width: diameter, height: diameter), flipped: false) { rect in
            color.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 0.5, dy: 0.5)).fill()
            return true
        }
        image.isTemplate = false
        return image
    }
}
