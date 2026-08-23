import SwiftUI
import AppKit

enum ShellState: Equatable {
    case launching
    case ready
    case failed(String)
}

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

struct ContentView: View {
    @ObservedObject var serveManager: ServeProcessManager
    @State private var state: ShellState = .launching
    @State private var copyConfirmation = false

    private let observatoryURL = ApiClient.defaultBaseURL

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            content
        }
        .frame(minWidth: 960, minHeight: 640)
        .task { await start() }
    }

    private var toolbar: some View {
        HStack {
            statusLabel
            Spacer()
            if copyConfirmation {
                Text("Copied")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .transition(.opacity)
            }
            Button("Copy Xcode Agent Paths") {
                AgentPaths.copyToPasteboard()
                withAnimation { copyConfirmation = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    withAnimation { copyConfirmation = false }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var statusLabel: some View {
        switch state {
        case .launching:
            Label("Starting…", systemImage: "circle.dotted")
                .foregroundStyle(.secondary)
        case .ready:
            Label("Running", systemImage: "circle.fill")
                .foregroundStyle(.green)
        case .failed:
            Label("Error", systemImage: "exclamationmark.circle.fill")
                .foregroundStyle(.red)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .launching:
            ProgressView("Starting ACP Bridge…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready:
            ObservatoryWebView(url: observatoryURL)
        case .failed(let message):
            errorView(message)
        }
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.largeTitle)
                .foregroundStyle(.orange)
            Text(message)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 480)
            Button("Retry") {
                Task { await start() }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private func start() async {
        state = .launching
        do {
            try await serveManager.ensureRunning()
            state = .ready
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

#Preview {
    ContentView(serveManager: ServeProcessManager())
}
