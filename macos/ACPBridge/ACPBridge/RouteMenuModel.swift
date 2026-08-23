import Foundation

enum RouteMenuError: Error, Equatable, LocalizedError {
    /// `setRoute`/`setModel` called before `refresh()` ever succeeded, so
    /// there's no known current route to act against.
    case notLoaded
    case unknownRoute(String)

    var errorDescription: String? {
        switch self {
        case .notLoaded:
            return "Route state has not loaded yet."
        case .unknownRoute(let name):
            return "Unknown route: \(name)."
        }
    }
}

/// View-model backing the MenuBarExtra "Next conversation" Route/Model
/// submenus. Talks only to `GET`/`PUT /api/acp-route` and
/// `GET /api/acp-models` — never writes `acp-route.json` directly (that
/// stays server-side, per the design doc).
@MainActor
final class RouteMenuModel: ObservableObject {
    @Published private(set) var routes: [String] = []
    @Published private(set) var currentRoute: String?
    @Published private(set) var models: [String] = []
    @Published private(set) var currentModel: String?
    @Published private(set) var isLoading = false
    @Published private(set) var lastError: String?

    private let apiClient: ApiClient

    init(apiClient: ApiClient = ApiClient()) {
        self.apiClient = apiClient
    }

    /// Loads the current next-conversation route/model, then that route's
    /// model list. Safe to call repeatedly (e.g. every time the menu opens).
    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let route = try await apiClient.acpRoute()
            routes = route.routes
            currentRoute = route.route
            currentModel = route.model
            lastError = nil
            await refreshModels(for: route.route)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Switches the *next* conversation's route. The previously stored
    /// model is route-specific, so it's dropped server-side by this call;
    /// the new route's model list is reloaded afterwards.
    func setRoute(_ name: String) async throws {
        guard routes.contains(name) else {
            throw RouteMenuError.unknownRoute(name)
        }
        let response = try await apiClient.putAcpRoute(route: name, model: nil)
        routes = response.routes
        currentRoute = response.route
        currentModel = response.model
        lastError = nil
        await refreshModels(for: response.route)
    }

    /// Sets (`id` non-nil) or clears (`id` nil) the model for the current
    /// route. Requires a prior successful `refresh()`/`setRoute()`.
    func setModel(_ id: String?) async throws {
        guard let route = currentRoute else {
            throw RouteMenuError.notLoaded
        }
        let response = try await apiClient.putAcpRoute(route: route, model: id)
        routes = response.routes
        currentRoute = response.route
        currentModel = response.model
        lastError = nil
    }

    private func refreshModels(for route: String) async {
        do {
            let response = try await apiClient.acpModels(route: route)
            models = response.models
        } catch {
            // Model list is best-effort — the route switch itself already
            // succeeded, so don't clobber `lastError` over a models fetch.
            models = []
        }
    }
}
