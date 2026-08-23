import SwiftUI
import WebKit

/// Hosts the existing web Observatory dashboard in-app. Business logic and
/// UI stay in the Bun/TS kernel; this is purely a `WKWebView` wrapper.
struct ObservatoryWebView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> WKWebView {
        let webView = WKWebView()
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        guard nsView.url != url else { return }
        nsView.load(URLRequest(url: url))
    }
}
