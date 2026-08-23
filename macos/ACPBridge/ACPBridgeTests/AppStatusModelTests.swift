import XCTest
@testable import ACPBridge

/// Uses the `MockURLProtocol` defined in `ServeProcessManagerTests.swift`
/// (same test target) to serve fixture JSON without a live `acp-serve`.
@MainActor
final class AppStatusModelTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.handler = nil
        MockURLProtocol.errorToThrow = nil
        super.tearDown()
    }

    func testRefreshPublishesBackendsFromFixtureJSON() async {
        let json = """
        {"ok":true,"product":"xcode-acp-bridge","version":"0.1.0","route":"opencode","model":null,\
        "routes":["opencode","cursor"],"backends":[\
        {"name":"opencode","command":"opencode","executable":true},\
        {"name":"cursor","command":"agent","executable":true,"auth":{"ok":true,"authenticated":true,"detail":"logged in as x"}}\
        ],"layoutMode":"app"}
        """
        MockURLProtocol.handler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, json.data(using: .utf8)!)
        }
        let model = AppStatusModel(apiClient: ApiClient(session: MockURLProtocol.makeSession()))

        await model.refresh()

        XCTAssertEqual(model.backends.count, 2)
        XCTAssertEqual(model.backends[0].name, "opencode")
        XCTAssertTrue(model.backends[0].executable)
        XCTAssertNil(model.backends[0].auth)
        XCTAssertEqual(model.backends[1].name, "cursor")
        XCTAssertEqual(model.backends[1].auth?.detail, "logged in as x")
        XCTAssertEqual(model.backends[1].auth?.authenticated, true)
        XCTAssertEqual(model.layoutMode, "app")
        XCTAssertNil(model.lastError)
    }

    func testRefreshSurfacesErrorAndLeavesBackendsEmptyOnConnectionFailure() async {
        MockURLProtocol.errorToThrow = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
        let model = AppStatusModel(apiClient: ApiClient(session: MockURLProtocol.makeSession()))

        await model.refresh()

        XCTAssertTrue(model.backends.isEmpty)
        XCTAssertNotNil(model.lastError)
    }
}
