import SwiftUI

/// MenuBarExtra content — the design's full M1+M2+M3 menu information
/// architecture (Next conversation route/model, Recent sessions, Backend
/// status, Settings…, baseline actions).
struct MenuBarView: View {
    @ObservedObject var serveManager: ServeProcessManager
    @ObservedObject var routeMenu: RouteMenuModel
    @ObservedObject var appStatus: AppStatusModel
    @ObservedObject var sessionsMenu: SessionsMenuModel
    @ObservedObject var navigator: ObservatoryNavigationModel
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
        recentSessionsSubmenu
        Divider()
        Button("Open Observatory") {
            activateObservatoryWindow()
        }
        serveLifecycleButtons
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
        switch serveManager.state {
        case .ready:
            Text("ACP Bridge — Running")
        case .launching:
            Text("ACP Bridge — Starting…")
        case .failed:
            Text("ACP Bridge — Error")
        case .idle:
            Text("ACP Bridge — Stopped")
        }
    }

    @ViewBuilder
    private var serveLifecycleButtons: some View {
        switch serveManager.state {
        case .ready:
            Button("Stop Server") {
                serveManager.shutdown()
            }
        case .idle, .failed:
            Button("Start Server") {
                Task { await serveManager.start() }
            }
        case .launching:
            Button("Start Server") {}
                .disabled(true)
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

    @ViewBuilder
    private var recentSessionsSubmenu: some View {
        Menu("Recent sessions") {
            if sessionsMenu.sessions.isEmpty {
                Text(sessionsMenu.isLoading ? "Loading…" : "No recent sessions")
            } else {
                ForEach(sessionsMenu.sessions) { session in
                    Menu(session.displayTitle) {
                        sessionRowActions(session)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func sessionRowActions(_ session: SessionSummary) -> some View {
        let rowBusy = sessionsMenu.pendingBridgePid == session.bridgePid
        Menu("Set model") {
            setModelOptions(session)
        }
        .disabled(!session.canSetModel || rowBusy)
        Button("Resume in Terminal") {
            Task { try? await sessionsMenu.resume(session) }
        }
        .disabled(!session.canResume || rowBusy)
        Button("Open in Observatory") {
            navigator.navigate(to: sessionsMenu.observatoryURL(for: session, baseURL: ApiClient.defaultBaseURL))
            activateObservatoryWindow()
        }
    }

    @ViewBuilder
    private func setModelOptions(_ session: SessionSummary) -> some View {
        let options = session.route.flatMap { sessionsMenu.modelOptions[$0] } ?? []
        if options.isEmpty {
            Text("No models available")
        } else {
            ForEach(options, id: \.self) { model in
                Button {
                    Task { try? await sessionsMenu.setModel(model, for: session) }
                } label: {
                    routeLabel(model, isSelected: model == session.model)
                }
            }
        }
    }

    private func activateObservatoryWindow() {
        NSApp.activate(ignoringOtherApps: true)
        if let window = NSApp.windows.first(where: { $0.canBecomeKey }) {
            window.makeKeyAndOrderFront(nil)
        } else {
            openWindow(id: MainWindow.id)
        }
    }
}

/// Reloads everything the menu renders. Menu *content* views don't reliably
/// receive SwiftUI lifecycle events, so nothing refreshes when the user opens
/// the menu — the label drives this instead, on a timer.
enum MenuDataRefresher {
    /// Chosen against how the data ages: route/model change only when the user
    /// changes them (in this menu or the Observatory), and sessions change when
    /// Xcode spawns a bridge. `/api/app/status`'s backend probes are cached
    /// server-side for 90s, so polling faster mostly re-reads that cache.
    static let interval: Duration = .seconds(30)

    static func refreshAll(
        routeMenu: RouteMenuModel,
        appStatus: AppStatusModel,
        sessionsMenu: SessionsMenuModel
    ) async {
        await routeMenu.refresh()
        await appStatus.refresh()
        await sessionsMenu.refresh()
    }
}

/// MenuBarExtra label — a plain `View`, unlike the menu content, so it
/// reliably receives SwiftUI lifecycle events. Runs the initial (and
/// post-health-check) refresh, then keeps the menu current on a timer.
struct MenuBarLabel: View {
    @ObservedObject var serveManager: ServeProcessManager
    @ObservedObject var routeMenu: RouteMenuModel
    @ObservedObject var appStatus: AppStatusModel
    @ObservedObject var sessionsMenu: SessionsMenuModel
    var refreshInterval: Duration = MenuDataRefresher.interval

    var body: some View {
        Image(systemName: serveManager.isRunning ? "bolt.circle.fill" : "bolt.circle")
            .task(id: serveManager.isRunning) {
                guard serveManager.isRunning else { return }
                while !Task.isCancelled {
                    await MenuDataRefresher.refreshAll(
                        routeMenu: routeMenu,
                        appStatus: appStatus,
                        sessionsMenu: sessionsMenu
                    )
                    do {
                        try await Task.sleep(for: refreshInterval)
                    } catch {
                        return
                    }
                }
            }
    }
}
