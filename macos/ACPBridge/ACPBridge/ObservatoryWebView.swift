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
///
/// Reloads are driven by a separate `reloadToken` so ⌘R / toolbar Reload keep
/// the current page (including deep links) without inventing a new navigation.
struct ObservatoryWebView: NSViewRepresentable {
    let navigation: ObservatoryNavigation
    let reloadToken: UUID

    final class Coordinator {
        /// Navigation token already handed to the WebView.
        var loadedNavigationID: UUID?
        /// Last reload token that was applied (`nil` until the first update).
        var appliedReloadToken: UUID?

        func shouldLoad(_ navigation: ObservatoryNavigation) -> Bool {
            navigation.id != loadedNavigationID
        }

        func shouldReload(_ reloadToken: UUID) -> Bool {
            appliedReloadToken != nil && appliedReloadToken != reloadToken
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let webView = WKWebView()
        // Default WKWebView paints white until the first paint — match Observatory bg.
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = ObservatoryTheme.bgNSColor
        webView.wantsLayer = true
        webView.layer?.backgroundColor = ObservatoryTheme.bgNSColor.cgColor
        load(into: webView, coordinator: context.coordinator)
        context.coordinator.appliedReloadToken = reloadToken
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        if context.coordinator.shouldLoad(navigation) {
            load(into: nsView, coordinator: context.coordinator)
            context.coordinator.appliedReloadToken = reloadToken
            return
        }
        if context.coordinator.shouldReload(reloadToken) {
            context.coordinator.appliedReloadToken = reloadToken
            // Bypass WKWebView's HTTP cache so rebuilt `public/` assets show up.
            nsView.reloadFromOrigin()
        }
    }

    private func load(into webView: WKWebView, coordinator: Coordinator) {
        coordinator.loadedNavigationID = navigation.id
        webView.load(URLRequest(url: navigation.url))
    }
}
