import SwiftUI

/// MenuBarExtra content — the design's full M1+M2 menu information
/// architecture (Next conversation route/model, Backend status, Settings…,
/// baseline actions). "Recent sessions" (Task 10) is intentionally still out
/// of scope here.
struct MenuBarView: View {
    @ObservedObject var serveManager: ServeProcessManager
    @ObservedObject var routeMenu: RouteMenuModel
    @ObservedObject var appStatus: AppStatusModel
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    private var mutatingItemsDisabled: Bool {
        !serveManager.isRunning || routeMenu.isLoading
    }

    var body: some View {
        statusHeader
        if let lastError = routeMenu.lastError {
            Text(lastError)
        }
        Menu("Next conversation") {
            routeSubmenu
            modelSubmenu
        }
        .disabled(mutatingItemsDisabled)
        Divider()
        Button("Open Observatory") {
            NSApp.activate(ignoringOtherApps: true)
            if let window = NSApp.windows.first(where: { $0.canBecomeKey }) {
                window.makeKeyAndOrderFront(nil)
            } else {
                openWindow(id: MainWindow.id)
            }
        }
        backendStatusSubmenu
        Button("Copy Xcode Agent Paths") {
            AgentPaths.copyToPasteboard()
        }
        Divider()
        Button("Settings…") {
            openSettings()
        }
        Button("Quit ACP Bridge") {
            NSApp.terminate(nil)
        }
    }

    @ViewBuilder
    private var statusHeader: some View {
        if serveManager.isRunning {
            Text("ACP Bridge — Running")
        } else {
            Text("ACP Bridge — Starting…")
        }
    }

    @ViewBuilder
    private var backendStatusSubmenu: some View {
        Menu("Backend status") {
            if let error = appStatus.lastError {
                Text(error)
            } else if appStatus.backends.isEmpty {
                Text("Loading…")
            } else {
                ForEach(appStatus.backends, id: \.name) { backend in
                    backendStatusRows(backend)
                }
            }
        }
    }

    @ViewBuilder
    private func backendStatusRows(_ backend: BackendStatus) -> some View {
        Text("\(backend.name): \(backend.executable ? "found" : "not found") — \(backend.command)")
        if let auth = backend.auth {
            Text("  \(auth.authenticated ? "Signed in" : "Not signed in") — \(auth.detail)")
        }
    }

    @ViewBuilder
    private var routeSubmenu: some View {
        Menu("Route") {
            if routeMenu.routes.isEmpty {
                Text("No routes available")
            }
            ForEach(routeMenu.routes, id: \.self) { route in
                Button {
                    Task { try? await routeMenu.setRoute(route) }
                } label: {
                    routeLabel(route, isSelected: route == routeMenu.currentRoute)
                }
            }
        }
    }

    @ViewBuilder
    private var modelSubmenu: some View {
        Menu("Model") {
            Button {
                Task { try? await routeMenu.setModel(nil) }
            } label: {
                routeLabel("Default", isSelected: routeMenu.currentModel == nil)
            }
            if !routeMenu.models.isEmpty {
                Divider()
                ForEach(routeMenu.models, id: \.self) { model in
                    Button {
                        Task { try? await routeMenu.setModel(model) }
                    } label: {
                        routeLabel(model, isSelected: model == routeMenu.currentModel)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func routeLabel(_ name: String, isSelected: Bool) -> some View {
        if isSelected {
            Label(name, systemImage: "checkmark")
        } else {
            Text(name)
        }
    }
}

/// MenuBarExtra label — a plain `View`, unlike the menu content, so it
/// reliably receives SwiftUI lifecycle events. Used to trigger the initial
/// (and post-health-check) `RouteMenuModel.refresh()`.
struct MenuBarLabel: View {
    @ObservedObject var serveManager: ServeProcessManager
    @ObservedObject var routeMenu: RouteMenuModel
    @ObservedObject var appStatus: AppStatusModel

    var body: some View {
        Image(systemName: serveManager.isRunning ? "bolt.circle.fill" : "bolt.circle")
            .task(id: serveManager.isRunning) {
                guard serveManager.isRunning else { return }
                await routeMenu.refresh()
                await appStatus.refresh()
            }
    }
}
