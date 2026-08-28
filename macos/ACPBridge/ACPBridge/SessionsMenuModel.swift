import Foundation

/// One "Recent sessions" menu row — either a grouped ACP session (several
/// bridge spawns sharing one `acpSessionId`, e.g. a resumed conversation) or
/// a standalone spawn with no session id yet. Decoded directly from
/// `GET /api/acp-conversation-sessions`'s discriminated-union JSON
/// (`kind: "session"` carries `representativeBridgePid`; `kind: "singleton"`
/// nests the lone spawn under `spawn`).
struct SessionSummary: Decodable, Identifiable, Equatable {
    let id: String
    let bridgePid: Int
    let acpSessionId: String?
    let status: String
    let route: String?
    let model: String?
    let cwd: String?
    let lastActivityAt: String

    /// Resume always 409s without a session id — the server hands the ACP
    /// session id straight to the resume helper
    /// (`if (!detail.acpSessionId) return c.json({ error: "no session id" }, 409)`).
    var canResume: Bool { acpSessionId != nil }

    /// Disconnect only applies to a live Xcode stdio spawn — we SIGTERM
    /// that `acp-bridge` so Xcode drops the ACP session.
    var canDisconnect: Bool { status == "live" }

    /// Set-model only 409s when there's *neither* a session id to persist
    /// against *nor* a live process to inject into — a live process with no
    /// session id yet still succeeds via the in-process model command.
    var canSetModel: Bool { acpSessionId != nil || status == "live" }

    /// Whether `model` is the one this session is on — used by the Set model
    /// submenu so the current choice can be shown as an `NSMenuItem` check.
    func isSelectedModel(_ model: String) -> Bool { self.model == model }

    /// Short menu label — route plus the working directory's last path
    /// component, since bridge pids alone aren't meaningful to users.
    var displayTitle: String {
        let routeLabel = route ?? "unknown route"
        guard let cwd, !cwd.isEmpty else { return routeLabel }
        return "\(routeLabel) — \((cwd as NSString).lastPathComponent)"
    }

    private enum CodingKeys: String, CodingKey {
        case kind
        case acpSessionId
        case representativeBridgePid
        case status
        case route
        case model
        case cwd
        case lastActivityAt
        case spawn
    }

    private struct Spawn: Decodable {
        let bridgePid: Int
        let acpSessionId: String?
        let status: String
        let route: String?
        let model: String?
        let cwd: String?
        let lastActivityAt: String
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "singleton":
            let spawn = try container.decode(Spawn.self, forKey: .spawn)
            id = "spawn-\(spawn.bridgePid)"
            bridgePid = spawn.bridgePid
            acpSessionId = spawn.acpSessionId
            status = spawn.status
            route = spawn.route
            model = spawn.model
            cwd = spawn.cwd
            lastActivityAt = spawn.lastActivityAt
        case "session":
            let sessionId = try container.decode(String.self, forKey: .acpSessionId)
            id = "session-\(sessionId)"
            bridgePid = try container.decode(Int.self, forKey: .representativeBridgePid)
            acpSessionId = sessionId
            status = try container.decode(String.self, forKey: .status)
            route = try container.decodeIfPresent(String.self, forKey: .route)
            model = try container.decodeIfPresent(String.self, forKey: .model)
            cwd = try container.decodeIfPresent(String.self, forKey: .cwd)
            lastActivityAt = try container.decode(String.self, forKey: .lastActivityAt)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "unknown session-list kind: \(kind)"
            )
        }
    }

    func replacingModel(_ model: String) -> SessionSummary {
        SessionSummary(
            id: id,
            bridgePid: bridgePid,
            acpSessionId: acpSessionId,
            status: status,
            route: route,
            model: model,
            cwd: cwd,
            lastActivityAt: lastActivityAt
        )
    }

    private init(
        id: String,
        bridgePid: Int,
        acpSessionId: String?,
        status: String,
        route: String?,
        model: String?,
        cwd: String?,
        lastActivityAt: String
    ) {
        self.id = id
        self.bridgePid = bridgePid
        self.acpSessionId = acpSessionId
        self.status = status
        self.route = route
        self.model = model
        self.cwd = cwd
        self.lastActivityAt = lastActivityAt
    }
}

/// View-model backing the MenuBarExtra "Recent sessions" submenu (M3). Reads
/// `GET /api/acp-conversation-sessions` and offers per-row Set model /
/// Resume / Disconnect / Open in Observatory — mirroring the server's own
/// 409 rules (via `SessionSummary.canSetModel`/`canResume`/`canDisconnect`)
/// so the menu disables actions that would fail rather than surfacing an
/// error after the fact.
@MainActor
final class SessionsMenuModel: ObservableObject {
    @Published private(set) var sessions: [SessionSummary] = []
    @Published private(set) var isLoading = false
    @Published private(set) var lastError: String?
    @Published private(set) var modelOptions: [String: [String]] = [:]

    /// Bridge pid of whichever row currently has an in-flight Set model /
    /// Resume / Disconnect call, so the menu can disable just that row rather
    /// than every row while a request is outstanding.
    @Published private(set) var pendingBridgePid: Int?

    private let apiClient: ApiClient
    private let limit: Int

    init(apiClient: ApiClient = ApiClient(), limit: Int = 8) {
        self.apiClient = apiClient
        self.limit = limit
    }

    /// Loads the most recent sessions (grouped parents), newest first,
    /// capped at `limit`, then best-effort preloads each distinct route's
    /// model list so "Set model" submenus don't fetch on first open — menu
    /// content views don't reliably receive SwiftUI lifecycle events, so
    /// there's no `.task` to hang a lazy per-row load off of.
    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let all = try await apiClient.acpConversationSessions()
            sessions = Array(all.prefix(limit))
            lastError = nil
            await loadModelOptions(forRoutesIn: sessions)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Loads (and caches) the model list for `route`. Best-effort: a fetch
    /// failure leaves that route's submenu with nothing to pick rather than
    /// clobbering `lastError` over a secondary fetch.
    func loadModelOptions(for route: String) async {
        guard modelOptions[route] == nil else { return }
        do {
            let response = try await apiClient.acpModels(route: route)
            modelOptions[route] = response.models
        } catch {
            modelOptions[route] = []
        }
    }

    /// Sets `session`'s model. Callers should gate this on
    /// `session.canSetModel`; this still throws (and publishes `lastError`)
    /// if the server disagrees.
    func setModel(_ model: String, for session: SessionSummary) async throws {
        pendingBridgePid = session.bridgePid
        defer { pendingBridgePid = nil }
        do {
            _ = try await apiClient.putConversationModel(bridgePid: session.bridgePid, model: model)
            lastError = nil
            if let index = sessions.firstIndex(where: { $0.id == session.id }) {
                sessions[index] = sessions[index].replacingModel(model)
            }
        } catch {
            lastError = error.localizedDescription
            throw error
        }
    }

    /// Resumes `session` in Terminal via the server's resume helper.
    /// Callers should gate this on `session.canResume`.
    func resume(_ session: SessionSummary) async throws {
        pendingBridgePid = session.bridgePid
        defer { pendingBridgePid = nil }
        do {
            _ = try await apiClient.resumeConversation(bridgePid: session.bridgePid)
            lastError = nil
        } catch {
            lastError = error.localizedDescription
            throw error
        }
    }

    /// SIGTERMs `session`'s live `acp-bridge` so Xcode drops the ACP
    /// stdio connection. Callers should gate this on `session.canDisconnect`.
    func disconnect(_ session: SessionSummary) async throws {
        pendingBridgePid = session.bridgePid
        defer { pendingBridgePid = nil }
        do {
            _ = try await apiClient.disconnectConversation(bridgePid: session.bridgePid)
            lastError = nil
            await refresh()
        } catch {
            lastError = error.localizedDescription
            throw error
        }
    }

    /// Models shown in a session's Set model submenu: the route's list,
    /// with the session's current model prepended when the backend list
    /// doesn't include it (so the checkmark row still exists).
    func modelChoices(for session: SessionSummary) -> [String] {
        var options = session.route.flatMap { modelOptions[$0] } ?? []
        if let current = session.model, !current.isEmpty, !options.contains(current) {
            options.insert(current, at: 0)
        }
        return options
    }

    /// Builds the Observatory deep link. Grouped sessions open the merged
    /// timeline (`?session=`). Spawns without an ACP session id keep `?pid=`.
    func observatoryURL(for session: SessionSummary, baseURL: URL) -> URL {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("conversation.html"),
            resolvingAgainstBaseURL: false
        )!
        if let sessionId = session.acpSessionId, !sessionId.isEmpty {
            components.queryItems = [URLQueryItem(name: "session", value: sessionId)]
        } else {
            components.queryItems = [URLQueryItem(name: "pid", value: String(session.bridgePid))]
        }
        return components.url!
    }

    private func loadModelOptions(forRoutesIn sessions: [SessionSummary]) async {
        for route in Set(sessions.compactMap(\.route)) {
            await loadModelOptions(for: route)
        }
    }
}
