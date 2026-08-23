import SwiftUI

/// Shared identifier for the main `WindowGroup`, so `MenuBarView`'s "Open
/// Observatory" action can re-open it via `openWindow(id:)` if the user
/// closed it.
enum MainWindow {
    static let id = "main"
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var serveManager: ServeProcessManager?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // `showDockIcon`'s effect while running (Settings > onChange) doesn't
        // cover app *launch* — set the activation policy once up front from
        // whatever was persisted last time.
        let showDockIcon = UserDefaults.standard.bool(forKey: AppSettingsKeys.showDockIcon)
        NSApp.setActivationPolicy(showDockIcon ? .regular : .accessory)
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Default policy: stop acp-serve on Quit, unless the user opted into
        // "leave server running after Quit". Never touches Xcode-owned
        // acp-bridge processes (those live over stdio, outside our control).
        guard !UserDefaults.standard.bool(forKey: AppSettingsKeys.leaveServerRunningOnQuit) else { return }
        serveManager?.shutdown()
    }
}

@main
struct ACPBridgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var serveManager = ServeProcessManager()
    @StateObject private var routeMenu = RouteMenuModel()
    @StateObject private var appStatus = AppStatusModel()
    @AppStorage(AppSettingsKeys.showMenuBarExtra) private var showMenuBarExtra = true

    init() {
        // Must run before any `@AppStorage` binding (above) or direct
        // `UserDefaults` read (AppDelegate) of these keys evaluates.
        AppSettingsKeys.registerDefaults()
    }

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

        MenuBarExtra(isInserted: $showMenuBarExtra) {
            MenuBarView(serveManager: serveManager, routeMenu: routeMenu, appStatus: appStatus)
        } label: {
            MenuBarLabel(serveManager: serveManager, routeMenu: routeMenu, appStatus: appStatus)
        }

        Settings {
            SettingsView()
        }
    }
}
