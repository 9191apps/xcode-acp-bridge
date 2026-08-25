import SwiftUI
import AppKit

/// Matches `public/styles.css` Observatory palette so the native chrome
/// (toolbar, empty/error panes) sits flush with the WKWebView content.
enum ObservatoryTheme {
    static let bg = Color(red: 10 / 255, green: 14 / 255, blue: 20 / 255) // --bg
    static let panel = Color(red: 15 / 255, green: 20 / 255, blue: 28 / 255) // ~--panel
    static let border = Color(red: 30 / 255, green: 40 / 255, blue: 54 / 255) // --border
    static let text = Color(red: 217 / 255, green: 225 / 255, blue: 236 / 255) // --text
    static let textDim = Color(red: 139 / 255, green: 150 / 255, blue: 165 / 255) // --text-dim
    static let accent = Color(red: 255 / 255, green: 184 / 255, blue: 77 / 255) // --accent
    static let green = Color(red: 61 / 255, green: 220 / 255, blue: 132 / 255) // --green
    static let red = Color(red: 255 / 255, green: 93 / 255, blue: 93 / 255) // --red

    /// AppKit twin of `bg` — used to kill WKWebView's default white flash.
    static let bgNSColor = NSColor(calibratedRed: 10 / 255, green: 14 / 255, blue: 20 / 255, alpha: 1)
}
