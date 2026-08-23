import SwiftUI
import WebKit

/// Hosts the existing web Observatory dashboard in-app. Business logic and
/// UI stay in the Bun/TS kernel; this is purely a `WKWebView` wrapper.
///
/// Loads are driven by `ObservatoryNavigation.id` rather than by comparing the
/// live `WKWebView.url` to the bound URL: the user is expected to browse away
/// from wherever we last sent them, and any unrelated re-render of
/// `ContentView` (a Copy Paths confirmation, a status change) would otherwise
/// yank them back.
struct ObservatoryWebView: NSViewRepresentable {
    let navigation: ObservatoryNavigation

    final class Coordinator {
        /// Navigation token already handed to the WebView.
        var loadedNavigationID: UUID?

        func shouldLoad(_ navigation: ObservatoryNavigation) -> Bool {
            navigation.id != loadedNavigationID
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let webView = WKWebView()
        load(into: webView, coordinator: context.coordinator)
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        guard context.coordinator.shouldLoad(navigation) else { return }
        load(into: nsView, coordinator: context.coordinator)
    }

    private func load(into webView: WKWebView, coordinator: Coordinator) {
        coordinator.loadedNavigationID = navigation.id
        webView.load(URLRequest(url: navigation.url))
    }
}
