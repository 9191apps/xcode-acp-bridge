import Foundation

/// Product fingerprint returned by our `acp-serve` sidecar's `/health` endpoint.
/// Used to distinguish "our server" from some other process squatting on the port.
enum ProductInfo {
    static let identifier = "xcode-acp-bridge"
}

struct Health: Decodable, Equatable {
    let ok: Bool
    let product: String
    let version: String
}

/// `GET`/`PUT /api/acp-route` response shape — the *next* conversation's
/// route/model, resolved against stored state or `config.defaultRoute`.
struct AcpRoute: Decodable, Equatable {
    let route: String
    let defaultRoute: String
    let routes: [String]
    let source: String
    let model: String?
}

/// `GET /api/acp-models?route=` response shape.
struct AcpModels: Decodable, Equatable {
    let route: String
    let models: [String]
    let source: String
    let warning: String?
    let current: String?
}

/// Per-backend auth-probe detail nested in `AppStatus.backends`, present only
/// for backends that support an auth check (currently `cursor`/`qodercli`).
struct BackendAuthStatus: Decodable, Equatable {
    let ok: Bool
    let authenticated: Bool
    let detail: String
}

/// One entry of `AppStatus.backends` — a configured route's backend
/// executable + (when applicable) auth status.
struct BackendStatus: Decodable, Equatable {
    let name: String
    let command: String
    let executable: Bool
    let auth: BackendAuthStatus?
}

/// `GET /api/app/status` response shape — overall health plus per-backend
/// executable/auth detail, for the MenuBarExtra's "Backend status" submenu.
struct AppStatus: Decodable, Equatable {
    let ok: Bool
    let product: String
    let version: String
    let route: String
    let model: String?
    let routes: [String]
    let backends: [BackendStatus]
    let layoutMode: String
}

/// `PUT /api/acp-conversations/:bridgePid/model` success response shape.
struct ConversationModelUpdateResponse: Decodable, Equatable {
    let ok: Bool
    let bridgePid: Int
    let model: String
}

/// `POST /api/acp-conversations/:bridgePid/resume` success response shape.
struct ConversationResumeResponse: Decodable, Equatable {
    let ok: Bool
    let sessionId: String
}

enum ApiClientError: Error, Equatable {
    case invalidResponse
    case http(Int)
}

/// Thin HTTP client for the `acp-serve` sidecar. Only decodes responses;
/// product-fingerprint matching is the caller's responsibility (see
/// `ServeDecisionMaker`) so this type stays trivially unit-testable.
struct ApiClient {
    let baseURL: URL
    let session: URLSession

    init(baseURL: URL = ApiClient.defaultBaseURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    static let defaultBaseURL = URL(string: "http://127.0.0.1:8787")!

    func health() async throws -> Health {
        try await send(URLRequest(url: baseURL.appendingPathComponent("health")))
    }

    /// Reads the next-conversation route/model.
    func acpRoute() async throws -> AcpRoute {
        try await send(URLRequest(url: baseURL.appendingPathComponent("api/acp-route")))
    }

    /// Sets the next-conversation route (and, optionally, model). Passing
    /// `model: nil` omits the field entirely, which clears any previously
    /// stored model for the route (matches `PUT /api/acp-route` semantics).
    func putAcpRoute(route: String, model: String?) async throws -> AcpRoute {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/acp-route"))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = ["route": route]
        if let model {
            body["model"] = model
        }
        request.httpBody = try JSONEncoder().encode(body)
        return try await send(request)
    }

    /// Reads overall backend status (per-route executable + auth detail) for
    /// the MenuBarExtra's "Backend status" submenu.
    func appStatus() async throws -> AppStatus {
        try await send(URLRequest(url: baseURL.appendingPathComponent("api/app/status")))
    }

    /// Lists known/observed models for `route`.
    func acpModels(route: String) async throws -> AcpModels {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("api/acp-models"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "route", value: route)]
        return try await send(URLRequest(url: components.url!))
    }

    /// Lists recent ACP sessions grouped by `acpSessionId` (or standalone
    /// spawns with none yet), newest first — for the MenuBarExtra's
    /// "Recent sessions" submenu.
    func acpConversationSessions() async throws -> [SessionSummary] {
        try await send(URLRequest(url: baseURL.appendingPathComponent("api/acp-conversation-sessions")))
    }

    /// Sets a specific past/live conversation's model — unlike
    /// `putAcpRoute`, this affects an already-spawned conversation rather
    /// than only the *next* one.
    func putConversationModel(bridgePid: Int, model: String) async throws -> ConversationModelUpdateResponse {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/acp-conversations/\(bridgePid)/model"))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["model": model])
        return try await send(request)
    }

    /// Resumes a past conversation in Terminal via the server's resume helper.
    func resumeConversation(bridgePid: Int) async throws -> ConversationResumeResponse {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/acp-conversations/\(bridgePid)/resume"))
        request.httpMethod = "POST"
        return try await send(request)
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ApiClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw ApiClientError.http(http.statusCode)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
