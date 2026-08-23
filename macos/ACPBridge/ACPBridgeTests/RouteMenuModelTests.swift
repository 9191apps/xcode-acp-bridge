import XCTest
@testable import ACPBridge

/// Uses the `MockURLProtocol` defined in `ServeProcessManagerTests.swift`
/// (same test target) to serve fixture JSON without a live `acp-serve`.
@MainActor
final class RouteMenuModelTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.handler = nil
        MockURLProtocol.errorToThrow = nil
        super.tearDown()
    }

    private func makeModel(handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) -> RouteMenuModel {
        MockURLProtocol.handler = handler
        let client = ApiClient(session: MockURLProtocol.makeSession())
        return RouteMenuModel(apiClient: client)
    }

    private static func jsonResponse(_ url: URL, _ json: String) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        return (response, json.data(using: .utf8)!)
    }

    func testRefreshPublishesRoutesAndModelsFromFixtureJSON() async {
        let model = makeModel { request in
            if request.url!.path == "/api/acp-route" {
                return Self.jsonResponse(
                    request.url!,
                    #"{"route":"opencode","defaultRoute":"opencode","routes":["opencode","cursor"],"source":"state","model":"gpt-5"}"#
                )
            }
            XCTAssertEqual(request.url!.path, "/api/acp-models")
            XCTAssertEqual(request.url!.query, "route=opencode")
            return Self.jsonResponse(
                request.url!,
                #"{"route":"opencode","models":["gpt-5","gpt-5-mini"],"source":"command","current":"gpt-5"}"#
            )
        }

        await model.refresh()

        XCTAssertEqual(model.routes, ["opencode", "cursor"])
        XCTAssertEqual(model.currentRoute, "opencode")
        XCTAssertEqual(model.currentModel, "gpt-5")
        XCTAssertEqual(model.models, ["gpt-5", "gpt-5-mini"])
        XCTAssertNil(model.lastError)
    }

    func testRefreshSurfacesErrorAndLeavesRoutesEmptyOnFailure() async {
        MockURLProtocol.errorToThrow = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
        let client = ApiClient(session: MockURLProtocol.makeSession())
        let model = RouteMenuModel(apiClient: client)

        await model.refresh()

        XCTAssertTrue(model.routes.isEmpty)
        XCTAssertNil(model.currentRoute)
        XCTAssertNotNil(model.lastError)
    }

    func testSetRoutePutsAndReloadsModelsForNewRoute() async throws {
        let model = makeModel { request in
            if request.url!.path == "/api/acp-route" && request.httpMethod == "GET" {
                return Self.jsonResponse(
                    request.url!,
                    #"{"route":"opencode","defaultRoute":"opencode","routes":["opencode","cursor"],"source":"state","model":"gpt-5"}"#
                )
            }
            if request.url!.path == "/api/acp-route" && request.httpMethod == "PUT" {
                let body = try JSONDecoder().decode([String: String].self, from: request.ofHttpBody())
                XCTAssertEqual(body["route"], "cursor")
                XCTAssertNil(body["model"], "setRoute must not send a model — server drops the stale one")
                return Self.jsonResponse(
                    request.url!,
                    #"{"route":"cursor","defaultRoute":"opencode","routes":["opencode","cursor"],"source":"state","model":null}"#
                )
            }
            // /api/acp-models — fires once for the initial refresh's route
            // (opencode) and once more after setRoute("cursor") reloads.
            if request.url!.query == "route=opencode" {
                return Self.jsonResponse(
                    request.url!,
                    #"{"route":"opencode","models":["gpt-5"],"source":"command","current":"gpt-5"}"#
                )
            }
            XCTAssertEqual(request.url!.query, "route=cursor")
            return Self.jsonResponse(
                request.url!,
                #"{"route":"cursor","models":["claude"],"source":"observed","current":null}"#
            )
        }

        await model.refresh()
        try await model.setRoute("cursor")

        XCTAssertEqual(model.currentRoute, "cursor")
        XCTAssertNil(model.currentModel)
        XCTAssertEqual(model.models, ["claude"])
    }

    func testSetRouteRejectsUnknownRouteWithoutNetworkCall() async {
        let model = makeModel { request in
            Self.jsonResponse(
                request.url!,
                #"{"route":"opencode","defaultRoute":"opencode","routes":["opencode"],"source":"default","model":null}"#
            )
        }
        await model.refresh()

        do {
            try await model.setRoute("nonexistent")
            XCTFail("expected unknownRoute error")
        } catch RouteMenuError.unknownRoute("nonexistent") {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testSetModelNilClearsModelForCurrentRoute() async throws {
        let model = makeModel { request in
            if request.url!.path == "/api/acp-route" && request.httpMethod == "GET" {
                return Self.jsonResponse(
                    request.url!,
                    #"{"route":"opencode","defaultRoute":"opencode","routes":["opencode"],"source":"state","model":"gpt-5"}"#
                )
            }
            if request.httpMethod == "PUT" {
                let body = try JSONDecoder().decode([String: String].self, from: request.ofHttpBody())
                XCTAssertEqual(body["route"], "opencode")
                XCTAssertNil(body["model"])
                return Self.jsonResponse(
                    request.url!,
                    #"{"route":"opencode","defaultRoute":"opencode","routes":["opencode"],"source":"state","model":null}"#
                )
            }
            return Self.jsonResponse(
                request.url!,
                #"{"route":"opencode","models":[],"source":"none","current":null}"#
            )
        }
        await model.refresh()

        try await model.setModel(nil)

        XCTAssertNil(model.currentModel)
    }

    func testSetRouteFailurePublishesLastError() async {
        let model = makeModel { request in
            if request.url!.path == "/api/acp-route" && request.httpMethod == "GET" {
                return Self.jsonResponse(
                    request.url!,
                    #"{"route":"opencode","defaultRoute":"opencode","routes":["opencode","cursor"],"source":"state","model":null}"#
                )
            }
            // The PUT itself fails (e.g. acp-serve dropped between the menu
            // opening and the click) — should not be silently swallowed.
            throw NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
        }
        await model.refresh()
        XCTAssertNil(model.lastError)

        do {
            try await model.setRoute("cursor")
            XCTFail("expected error")
        } catch {
            XCTAssertNotNil(model.lastError)
        }
    }

    func testSetModelFailurePublishesLastError() async {
        let model = makeModel { request in
            if request.url!.path == "/api/acp-route" && request.httpMethod == "GET" {
                return Self.jsonResponse(
                    request.url!,
                    #"{"route":"opencode","defaultRoute":"opencode","routes":["opencode"],"source":"state","model":null}"#
                )
            }
            if request.url!.path == "/api/acp-models" {
                return Self.jsonResponse(
                    request.url!,
                    #"{"route":"opencode","models":[],"source":"none","current":null}"#
                )
            }
            throw NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
        }
        await model.refresh()
        XCTAssertNil(model.lastError)

        do {
            try await model.setModel("gpt-5")
            XCTFail("expected error")
        } catch {
            XCTAssertNotNil(model.lastError)
        }
    }

    func testSetModelThrowsNotLoadedBeforeFirstRefresh() async {
        let client = ApiClient(session: MockURLProtocol.makeSession())
        let model = RouteMenuModel(apiClient: client)

        do {
            try await model.setModel("gpt-5")
            XCTFail("expected notLoaded error")
        } catch RouteMenuError.notLoaded {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}

private extension URLRequest {
    /// `URLProtocol`-intercepted requests sometimes carry the body as a
    /// stream rather than `httpBody` (an `URLSession` implementation
    /// detail), so read both.
    func ofHttpBody() -> Data {
        if let httpBody {
            return httpBody
        }
        guard let stream = httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read > 0 {
                data.append(buffer, count: read)
            } else {
                break
            }
        }
        return data
    }
}
