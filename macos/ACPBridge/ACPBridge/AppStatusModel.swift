import Foundation

/// View-model backing the MenuBarExtra "Backend status" submenu. Read-only —
/// unlike `RouteMenuModel`, this never mutates server state, it just polls
/// `GET /api/app/status` for per-backend executable/auth detail.
@MainActor
final class AppStatusModel: ObservableObject {
    @Published private(set) var backends: [BackendStatus] = []
    @Published private(set) var layoutMode: String?
    @Published private(set) var lastError: String?

    private let apiClient: ApiClient

    init(apiClient: ApiClient = ApiClient()) {
        self.apiClient = apiClient
    }

    /// Safe to call repeatedly (e.g. every time the menu bar icon appears or
    /// `acp-serve` becomes healthy).
    func refresh() async {
        do {
            let status = try await apiClient.appStatus()
            backends = status.backends
            layoutMode = status.layoutMode
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }
}
