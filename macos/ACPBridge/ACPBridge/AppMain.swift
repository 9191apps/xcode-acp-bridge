import SwiftUI

/// Shared identifier for the main `WindowGroup`, so `MenuBarView`'s "Open
/// Observatory" action can re-open it via `openWindow(id:)` if the user
/// closed it.
enum MainWindow {
    static let id = "main"
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Owned here, not by any scene: with the Dock icon hidden or the window
    /// closed, `ContentView` may never appear, and acp-serve still has to run
    /// for the menu bar (and Xcode's own bridge traffic) to work.
    let serveManager = ServeProcessManager()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // `showDockIcon`'s effect while running (Settings > onChange) doesn't
        // cover app *launch* — set the activation policy once up front from
        // whatever was persisted last time.
        let showDockIcon = UserDefaults.standard.bool(forKey: AppSettingsKeys.showDockIcon)
        NSApp.setActivationPolicy(showDockIcon ? .regular : .accessory)
        Task { await serveManager.start() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Default policy: stop acp-serve on Quit, unless the user opted into
        // "leave server running after Quit". Never touches Xcode-owned
        // acp-bridge processes (those live over stdio, outside our control).
        guard !UserDefaults.standard.bool(forKey: AppSettingsKeys.leaveServerRunningOnQuit) else { return }
        serveManager.shutdown()
    }
}

@main
struct ACPBridgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var routeMenu = RouteMenuModel()
    @StateObject private var appStatus = AppStatusModel()
    @StateObject private var sessionsMenu = SessionsMenuModel()
    @StateObject private var observatoryNavigator = ObservatoryNavigationModel()
    @AppStorage(AppSettingsKeys.showMenuBarExtra) private var showMenuBarExtra = true

    init() {
        // Must run before any `@AppStorage` binding (above) or direct
        // `UserDefaults` read (AppDelegate) of these keys evaluates.
        AppSettingsKeys.registerDefaults()
    }

    var body: some Scene {
        WindowGroup(id: MainWindow.id) {
            ContentView(serveManager: appDelegate.serveManager, navigator: observatoryNavigator)
                .preferredColorScheme(.dark)
        }
        // Hide the system gray title bar; traffic lights sit on our dark toolbar.
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandMenu("ACP Bridge") {
                Button("Reload Observatory") {
                    observatoryNavigator.reload()
                }
                .keyboardShortcut("r", modifiers: .command)
                Divider()
                Button("Stop Server") {
                    appDelegate.serveManager.shutdown()
                }
                .disabled(!appDelegate.serveManager.isRunning)
                Button("Start Server") {
                    Task { await appDelegate.serveManager.start() }
                }
                .disabled(appDelegate.serveManager.isRunning)
                Button("Copy Xcode Agent Paths") {
                    AgentPaths.copyToPasteboard()
                }
            }
        }

        MenuBarExtra(isInserted: $showMenuBarExtra) {
            MenuBarView(
                serveManager: appDelegate.serveManager,
                routeMenu: routeMenu,
                appStatus: appStatus,
                sessionsMenu: sessionsMenu,
                navigator: observatoryNavigator
            )
        } label: {
            MenuBarLabel(
                serveManager: appDelegate.serveManager,
                routeMenu: routeMenu,
                appStatus: appStatus,
                sessionsMenu: sessionsMenu
            )
        }

        Settings {
            SettingsView()
        }
    }
}
