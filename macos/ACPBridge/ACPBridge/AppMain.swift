import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    var serveManager: ServeProcessManager?

    func applicationWillTerminate(_ notification: Notification) {
        // Default policy: stop acp-serve on Quit. Never touches Xcode-owned
        // acp-bridge processes (those live over stdio, outside our control).
        serveManager?.shutdown()
    }
}

@main
struct ACPBridgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var serveManager = ServeProcessManager()

    var body: some Scene {
        WindowGroup {
            ContentView(serveManager: serveManager)
                .onAppear { appDelegate.serveManager = serveManager }
        }
        .commands {
            CommandMenu("ACP Bridge") {
                Button("Copy Xcode Agent Paths") {
                    AgentPaths.copyToPasteboard()
                }
            }
        }
    }
}
