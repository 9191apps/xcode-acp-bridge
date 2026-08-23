import SwiftUI

/// Shared identifier for the main `WindowGroup`, so `MenuBarView`'s "Open
/// Observatory" action can re-open it via `openWindow(id:)` if the user
/// closed it.
enum MainWindow {
    static let id = "main"
}

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
    @StateObject private var routeMenu = RouteMenuModel()

    var body: some Scene {
        WindowGroup(id: MainWindow.id) {
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

        MenuBarExtra {
            MenuBarView(serveManager: serveManager, routeMenu: routeMenu)
        } label: {
            MenuBarLabel(serveManager: serveManager, routeMenu: routeMenu)
        }
    }
}
