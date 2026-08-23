import XCTest
@testable import ACPBridge

/// Intercepts requests so `ApiClient` can be tested without a real server.
final class MockURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    static var errorToThrow: Error?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let error = MockURLProtocol.errorToThrow {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        guard let handler = MockURLProtocol.handler else {
            XCTFail("MockURLProtocol.handler not set")
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: config)
    }
}

final class ApiClientTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.handler = nil
        MockURLProtocol.errorToThrow = nil
        super.tearDown()
    }

    func testHealthDecodesMatchingProduct() async throws {
        let json = #"{"ok":true,"product":"xcode-acp-bridge","version":"0.1.0"}"#.data(using: .utf8)!
        MockURLProtocol.handler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, json)
        }
        let client = ApiClient(session: MockURLProtocol.makeSession())
        let health = try await client.health()
        XCTAssertEqual(health, Health(ok: true, product: "xcode-acp-bridge", version: "0.1.0"))
    }

    func testHealthDecodesForeignProductWithoutThrowing() async throws {
        // ApiClient itself does not validate the fingerprint — that's the
        // decision maker's job — so a differing product should still decode.
        let json = #"{"ok":true,"product":"some-other-tool","version":"9.9.9"}"#.data(using: .utf8)!
        MockURLProtocol.handler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, json)
        }
        let client = ApiClient(session: MockURLProtocol.makeSession())
        let health = try await client.health()
        XCTAssertEqual(health.product, "some-other-tool")
    }

    func testHealthThrowsOnHttpError() async {
        MockURLProtocol.handler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!
            return (response, Data())
        }
        let client = ApiClient(session: MockURLProtocol.makeSession())
        do {
            _ = try await client.health()
            XCTFail("expected error")
        } catch let error as ApiClientError {
            XCTAssertEqual(error, .http(500))
        } catch {
            XCTFail("unexpected error type: \(error)")
        }
    }

    func testHealthThrowsOnConnectionFailure() async {
        MockURLProtocol.errorToThrow = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
        let client = ApiClient(session: MockURLProtocol.makeSession())
        do {
            _ = try await client.health()
            XCTFail("expected error")
        } catch {
            let nsError = error as NSError
            XCTAssertEqual(nsError.domain, NSURLErrorDomain)
            XCTAssertEqual(nsError.code, NSURLErrorCannotConnectToHost)
        }
    }
}

final class ServeDecisionMakerTests: XCTestCase {
    func testReuseWhenProductMatches() {
        let health = Health(ok: true, product: "xcode-acp-bridge", version: "0.1.0")
        let decision = ServeDecisionMaker.decide(healthResult: .success(health))
        XCTAssertEqual(decision, .reuse)
    }

    func testPortOccupiedByOtherWhenProductDiffers() {
        let health = Health(ok: true, product: "some-other-tool", version: "1.0.0")
        let decision = ServeDecisionMaker.decide(healthResult: .success(health))
        XCTAssertEqual(decision, .failure(.portOccupiedByOther("some-other-tool")))
    }

    func testSpawnWhenConnectionRefused() {
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
        let decision = ServeDecisionMaker.decide(healthResult: .failure(error))
        XCTAssertEqual(decision, .spawn)
    }

    func testSpawnWhenHostUnreachableOrTimedOut() {
        for code in [NSURLErrorCannotFindHost, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut, NSURLErrorNotConnectedToInternet] {
            let error = NSError(domain: NSURLErrorDomain, code: code)
            XCTAssertEqual(ServeDecisionMaker.decide(healthResult: .failure(error)), .spawn)
        }
    }

    func testHealthCheckFailedWhenResponseIsUnparseable() {
        // A decode failure isn't evidence of a *foreign* server (which would
        // decode fine, just with a different product) — it should be a
        // distinct error, not conflated with portOccupiedByOther.
        struct DecodeStandIn: Error {}
        let decision = ServeDecisionMaker.decide(healthResult: .failure(DecodeStandIn()))
        switch decision {
        case .failure(.healthCheckFailed):
            break
        default:
            XCTFail("expected healthCheckFailed, got \(decision)")
        }
    }

    func testHealthCheckFailedWhenHttpErrorStatus() {
        // Similarly, an unexpected HTTP status (e.g. 500) is not the same
        // signal as a successful response with a mismatched product.
        let decision = ServeDecisionMaker.decide(healthResult: .failure(ApiClientError.http(500)))
        switch decision {
        case .failure(.healthCheckFailed):
            break
        default:
            XCTFail("expected healthCheckFailed, got \(decision)")
        }
    }
}

final class AgentPathsTests: XCTestCase {
    func testExecutablePathPointsAtBundledAcpBridge() {
        let bundleURL = URL(fileURLWithPath: "/Applications/ACP Bridge.app")
        XCTAssertEqual(
            AgentPaths.executablePath(bundleURL: bundleURL),
            "/Applications/ACP Bridge.app/Contents/MacOS/acp-bridge"
        )
    }

    func testPasteboardTextIncludesEmptyInterpreter() {
        let bundleURL = URL(fileURLWithPath: "/Applications/ACP Bridge.app")
        let text = AgentPaths.pasteboardText(bundleURL: bundleURL)
        XCTAssertTrue(text.contains("Executable: /Applications/ACP Bridge.app/Contents/MacOS/acp-bridge"))
        XCTAssertTrue(text.contains("Interpreter: (leave empty)"))
    }
}
