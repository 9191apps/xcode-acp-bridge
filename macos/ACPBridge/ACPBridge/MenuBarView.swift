import SwiftUI

/// MenuBarExtra content — M1 subset of the design's menu information
/// architecture (Next conversation route/model + baseline actions).
/// "Recent sessions" (Task 10) and "Backend status" / "Settings…" (Task 9)
/// are intentionally out of scope here.
struct MenuBarView: View {
    @ObservedObject var serveManager: ServeProcessManager
    @ObservedObject var routeMenu: RouteMenuModel
    @Environment(\.openWindow) private var openWindow

    private var mutatingItemsDisabled: Bool {
        !serveManager.isRunning || routeMenu.isLoading
    }

    var body: some View {
        statusHeader
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
        Button("Copy Xcode Agent Paths") {
            AgentPaths.copyToPasteboard()
        }
        Divider()
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

    var body: some View {
        Image(systemName: serveManager.isRunning ? "bolt.circle.fill" : "bolt.circle")
            .task(id: serveManager.isRunning) {
                guard serveManager.isRunning else { return }
                await routeMenu.refresh()
            }
    }
}
