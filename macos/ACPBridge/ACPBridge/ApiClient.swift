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

    /// Lists known/observed models for `route`.
    func acpModels(route: String) async throws -> AcpModels {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("api/acp-models"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "route", value: route)]
        return try await send(URLRequest(url: components.url!))
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
