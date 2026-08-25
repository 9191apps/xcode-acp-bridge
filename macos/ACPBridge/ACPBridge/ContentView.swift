import SwiftUI
import AppKit

/// Builds the "Copy Xcode Agent paths" pasteboard text. Pure/testable —
/// no AppKit dependency beyond the bundle URL that's passed in.
enum AgentPaths {
    static func executablePath(bundleURL: URL) -> String {
        bundleURL.appendingPathComponent("Contents/MacOS/acp-bridge").path
    }

    static func pasteboardText(bundleURL: URL) -> String {
        "Executable: \(executablePath(bundleURL: bundleURL))\nInterpreter: (leave empty)"
    }

    @discardableResult
    static func copyToPasteboard(bundleURL: URL = Bundle.main.bundleURL) -> String {
        let text = pasteboardText(bundleURL: bundleURL)
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        return text
    }
}

/// One navigation request, identified rather than compared by URL: the
/// WebView treats `id` as a token it consumes, so an unrelated re-render can't
/// re-issue a load, while navigating twice to the *same* URL still does.
struct ObservatoryNavigation: Equatable {
    let id: UUID
    let url: URL

    init(url: URL, id: UUID = UUID()) {
        self.id = id
        self.url = url
    }
}

/// Shared Observatory navigation target — lets the MenuBarExtra's "Open in
/// Observatory" action (Task 10) steer the Dock window's `WKWebView` to a
/// specific conversation without either view knowing about the other
/// directly. Defaults to the Observatory root.
@MainActor
final class ObservatoryNavigationModel: ObservableObject {
    @Published private(set) var request = ObservatoryNavigation(url: ApiClient.defaultBaseURL)
    /// Bumped by `reload()` so the WebView reloads in place (⌘R / toolbar).
    @Published private(set) var reloadToken = UUID()

    func navigate(to url: URL) {
        request = ObservatoryNavigation(url: url)
    }

    func reload() {
        reloadToken = UUID()
    }
}

struct ContentView: View {
    @ObservedObject var serveManager: ServeProcessManager
    @ObservedObject var navigator: ObservatoryNavigationModel
    @State private var copyConfirmation = false

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Rectangle()
                .fill(ObservatoryTheme.border)
                .frame(height: 1)
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(ObservatoryTheme.bg)
        }
        .background(ObservatoryTheme.bg)
        // Pull chrome up under the traffic lights; left side stays empty for them.
        .ignoresSafeArea(edges: .top)
        .preferredColorScheme(.dark)
        .frame(minWidth: 960, minHeight: 640)
        // The delegate already kicked this off at launch; calling again is a
        // no-op unless a previous attempt failed or the server was shut down.
        .task { await serveManager.start() }
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            // Leading strip is for traffic lights + window drag only.
            Spacer(minLength: 78)
            statusLabel
            serveControlButton
            if copyConfirmation {
                Text("Copied")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ObservatoryTheme.textDim)
                    .transition(.opacity)
            }
            toolbarButton("Reload", enabled: serveManager.isRunning) {
                navigator.reload()
            }
            .keyboardShortcut("r", modifiers: .command)
            toolbarButton("Copy Xcode Agent Paths", enabled: true) {
                AgentPaths.copyToPasteboard()
                withAnimation { copyConfirmation = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    withAnimation { copyConfirmation = false }
                }
            }
        }
        .padding(.top, 10)
        .padding(.bottom, 8)
        .padding(.trailing, 14)
        .background {
            ZStack {
                ObservatoryTheme.bg
                WindowDragHandle()
            }
        }
    }

    private func toolbarButton(_ title: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(enabled ? ObservatoryTheme.text : ObservatoryTheme.textDim.opacity(0.5))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(ObservatoryTheme.panel)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(ObservatoryTheme.border, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    @ViewBuilder
    private var serveControlButton: some View {
        switch serveManager.state {
        case .ready:
            toolbarButton("Stop", enabled: true) {
                serveManager.shutdown()
            }
        case .idle, .failed:
            toolbarButton("Start", enabled: true) {
                Task { await serveManager.start() }
            }
        case .launching:
            toolbarButton("Start", enabled: false) {}
        }
    }

    @ViewBuilder
    private var statusLabel: some View {
        switch serveManager.state {
        case .idle:
            Label("Stopped", systemImage: "circle")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(ObservatoryTheme.textDim)
        case .launching:
            Label("Starting…", systemImage: "circle.dotted")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(ObservatoryTheme.textDim)
        case .ready:
            Label("Running", systemImage: "circle.fill")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(ObservatoryTheme.green)
        case .failed:
            Label("Error", systemImage: "exclamationmark.circle.fill")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(ObservatoryTheme.red)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch serveManager.state {
        case .launching:
            ProgressView("Starting ACP Bridge…")
                .tint(ObservatoryTheme.accent)
                .foregroundStyle(ObservatoryTheme.textDim)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .idle:
            VStack(spacing: 12) {
                Text("Server stopped")
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(ObservatoryTheme.textDim)
                toolbarButton("Start", enabled: true) {
                    Task { await serveManager.start() }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready:
            ObservatoryWebView(navigation: navigator.request, reloadToken: navigator.reloadToken)
        case .failed(let message):
            errorView(message)
        }
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.largeTitle)
                .foregroundStyle(ObservatoryTheme.accent)
            Text(message)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(ObservatoryTheme.text)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 480)
            toolbarButton("Retry", enabled: true) {
                Task { await serveManager.start() }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

#Preview {
    ContentView(serveManager: ServeProcessManager(), navigator: ObservatoryNavigationModel())
}

/// Transparent drag region so a `.hiddenTitleBar` window can still be moved
/// by grabbing the observatory chrome (buttons remain clickable above it).
/// Also restores title-bar double-click zoom/minimize (lost with hidden title bar).
private struct WindowDragHandle: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        DragNSView()
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    private final class DragNSView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }

        override func mouseUp(with event: NSEvent) {
            if event.clickCount == 2 {
                performTitlebarDoubleClickAction()
            }
            super.mouseUp(with: event)
        }

        private func performTitlebarDoubleClickAction() {
            guard let window else { return }
            // System Settings → Desktop & Dock → “Double-click a window’s title bar to”
            let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
            switch action {
            case "Minimize":
                window.miniaturize(nil)
            case "None":
                break
            default:
                window.performZoom(nil)
            }
        }
    }
}
