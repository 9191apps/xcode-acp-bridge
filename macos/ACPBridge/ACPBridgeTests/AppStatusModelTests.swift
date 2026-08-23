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

/// The periodic menu refresh (`MenuBarLabel`'s timer loop) — the loop itself is
/// a SwiftUI `.task`, so what's tested here is the one pass it repeats.
@MainActor
final class MenuDataRefresherTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.handler = nil
        MockURLProtocol.errorToThrow = nil
        super.tearDown()
    }

    func testRefreshAllReloadsRouteStatusAndSessions() async {
        var pathsRequested: [String] = []
        MockURLProtocol.handler = { request in
            let url = request.url!
            pathsRequested.append(url.path)
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let json: String
            switch url.path {
            case "/api/acp-route":
                json = """
                {"route":"cursor","defaultRoute":"opencode","routes":["opencode","cursor"],\
                "source":"state","model":"claude-3.5"}
                """
            case "/api/acp-models":
                json = #"{"route":"cursor","models":["claude-3.5"],"source":"command","current":"claude-3.5"}"#
            case "/api/app/status":
                json = """
                {"ok":true,"product":"xcode-acp-bridge","version":"0.1.0","route":"cursor","model":"claude-3.5",\
                "routes":["opencode","cursor"],"backends":[{"name":"cursor","command":"agent","executable":true}],\
                "layoutMode":"env"}
                """
            case "/api/acp-conversation-sessions":
                json = """
                [{"kind":"session","acpSessionId":"sess-1","spawns":[],\
                "startedAt":"2026-08-20T10:00:00.000Z","lastActivityAt":"2026-08-20T10:05:00.000Z",\
                "durationMs":0,"status":"live","promptCount":0,"toolCallCount":0,\
                "route":"cursor","model":"claude-3.5","cwd":"/Users/dev/project",\
                "representativeBridgePid":7}]
                """
            default:
                XCTFail("unexpected request path: \(url.path)")
                json = "{}"
            }
            return (response, json.data(using: .utf8)!)
        }
        let client = ApiClient(session: MockURLProtocol.makeSession())
        let routeMenu = RouteMenuModel(apiClient: client)
        let appStatus = AppStatusModel(apiClient: client)
        let sessionsMenu = SessionsMenuModel(apiClient: client)

        await MenuDataRefresher.refreshAll(
            routeMenu: routeMenu,
            appStatus: appStatus,
            sessionsMenu: sessionsMenu
        )

        XCTAssertEqual(routeMenu.currentRoute, "cursor")
        XCTAssertEqual(routeMenu.currentModel, "claude-3.5")
        XCTAssertEqual(appStatus.backends.map(\.name), ["cursor"])
        XCTAssertEqual(sessionsMenu.sessions.map(\.bridgePid), [7])
        XCTAssertTrue(pathsRequested.contains("/api/acp-route"))
        XCTAssertTrue(pathsRequested.contains("/api/app/status"))
        XCTAssertTrue(pathsRequested.contains("/api/acp-conversation-sessions"))
    }

    func testRepeatedRefreshPicksUpServerSideChanges() async {
        // What the timer buys: the second pass must reflect a route the user
        // changed elsewhere, rather than the first pass's cached answer.
        var routeReads = 0
        MockURLProtocol.handler = { request in
            let url = request.url!
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
            switch url.path {
            case "/api/acp-route":
                routeReads += 1
                let route = routeReads == 1 ? "opencode" : "cursor"
                let json = """
                {"route":"\(route)","defaultRoute":"opencode","routes":["opencode","cursor"],\
                "source":"state","model":null}
                """
                return (response, json.data(using: .utf8)!)
            case "/api/acp-models":
                return (response, #"{"route":"cursor","models":[],"source":"none","current":null}"#.data(using: .utf8)!)
            case "/api/app/status":
                let json = """
                {"ok":true,"product":"xcode-acp-bridge","version":"0.1.0","route":"opencode","model":null,\
                "routes":["opencode"],"backends":[],"layoutMode":"env"}
                """
                return (response, json.data(using: .utf8)!)
            default:
                return (response, "[]".data(using: .utf8)!)
            }
        }
        let client = ApiClient(session: MockURLProtocol.makeSession())
        let routeMenu = RouteMenuModel(apiClient: client)
        let appStatus = AppStatusModel(apiClient: client)
        let sessionsMenu = SessionsMenuModel(apiClient: client)

        await MenuDataRefresher.refreshAll(routeMenu: routeMenu, appStatus: appStatus, sessionsMenu: sessionsMenu)
        XCTAssertEqual(routeMenu.currentRoute, "opencode")

        await MenuDataRefresher.refreshAll(routeMenu: routeMenu, appStatus: appStatus, sessionsMenu: sessionsMenu)
        XCTAssertEqual(routeMenu.currentRoute, "cursor")
    }
}
