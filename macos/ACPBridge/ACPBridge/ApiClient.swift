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
        let url = baseURL.appendingPathComponent("health")
        let (data, response) = try await session.data(for: URLRequest(url: url))
        guard let http = response as? HTTPURLResponse else {
            throw ApiClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw ApiClientError.http(http.statusCode)
        }
        return try JSONDecoder().decode(Health.self, from: data)
    }
}
