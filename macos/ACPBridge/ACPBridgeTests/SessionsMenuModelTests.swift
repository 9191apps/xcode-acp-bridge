import XCTest
@testable import ACPBridge

/// Uses the `MockURLProtocol` defined in `ServeProcessManagerTests.swift`
/// (same test target) to serve fixture JSON without a live `acp-serve`.
@MainActor
final class SessionsMenuModelTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.handler = nil
        MockURLProtocol.errorToThrow = nil
        super.tearDown()
    }

    private func makeModel(
        limit: Int = 8,
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> SessionsMenuModel {
        MockURLProtocol.handler = handler
        let client = ApiClient(session: MockURLProtocol.makeSession())
        return SessionsMenuModel(apiClient: client, limit: limit)
    }

    private static func jsonResponse(_ url: URL, _ json: String) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        return (response, json.data(using: .utf8)!)
    }

    private static func jsonResponse(_ url: URL, status: Int, _ json: String) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (response, json.data(using: .utf8)!)
    }

    // MARK: - SessionSummary parsing (Step 1)

    func testDecodingSessionKindFixtureJSON() throws {
        let json = """
        [{"kind":"session","acpSessionId":"sess-abc","spawns":[],\
        "startedAt":"2026-08-20T10:00:00.000Z","lastActivityAt":"2026-08-20T10:05:00.000Z",\
        "durationMs":300000,"status":"live","promptCount":3,"toolCallCount":1,\
        "route":"cursor","model":"claude-3.5","cwd":"/Users/dev/project",\
        "representativeBridgePid":4242}]
        """
        let sessions = try JSONDecoder().decode([SessionSummary].self, from: json.data(using: .utf8)!)

        XCTAssertEqual(sessions.count, 1)
        let session = sessions[0]
        XCTAssertEqual(session.bridgePid, 4242)
        XCTAssertEqual(session.acpSessionId, "sess-abc")
        XCTAssertEqual(session.status, "live")
        XCTAssertEqual(session.route, "cursor")
        XCTAssertEqual(session.model, "claude-3.5")
        XCTAssertEqual(session.displayTitle, "cursor — project")
        XCTAssertTrue(session.canResume)
        XCTAssertTrue(session.canSetModel)
    }

    func testDecodingSingletonKindEndedWithNoSessionIdDisablesBothActions() throws {
        let json = """
        [{"kind":"singleton","spawn":{\
        "bridgePid":555,"backendPid":999,"route":"opencode","cwd":"/Users/dev/other",\
        "mcpXcodeSessionId":null,"acpSessionId":null,\
        "startedAt":"2026-08-19T09:00:00.000Z","endedAt":"2026-08-19T09:10:00.000Z",\
        "lastActivityAt":"2026-08-19T09:10:00.000Z","status":"ended","durationMs":600000,\
        "promptCount":1,"toolCallCount":0,"eventCount":5,"model":null}}]
        """
        let sessions = try JSONDecoder().decode([SessionSummary].self, from: json.data(using: .utf8)!)

        XCTAssertEqual(sessions.count, 1)
        let session = sessions[0]
        XCTAssertEqual(session.bridgePid, 555)
        XCTAssertNil(session.acpSessionId)
        XCTAssertEqual(session.status, "ended")
        // Server: no acpSessionId AND not live -> both PUT model and resume 409.
        XCTAssertFalse(session.canResume)
        XCTAssertFalse(session.canSetModel)
    }

    func testDecodingSingletonKindLiveWithNoSessionIdAllowsSetModelButNotResume() throws {
        let json = """
        [{"kind":"singleton","spawn":{\
        "bridgePid":777,"backendPid":888,"route":"opencode","cwd":"/Users/dev/live",\
        "mcpXcodeSessionId":null,"acpSessionId":null,\
        "startedAt":"2026-08-19T09:00:00.000Z","endedAt":null,\
        "lastActivityAt":"2026-08-19T09:10:00.000Z","status":"live","durationMs":600000,\
        "promptCount":1,"toolCallCount":0,"eventCount":5,"model":null}}]
        """
        let sessions = try JSONDecoder().decode([SessionSummary].self, from: json.data(using: .utf8)!)

        let session = sessions[0]
        // Server: no acpSessionId but liveRunning -> model command still succeeds.
        XCTAssertTrue(session.canSetModel)
        // Resume still needs an acpSessionId to hand the resume helper.
        XCTAssertFalse(session.canResume)
    }

    func testDecodingUnknownKindThrows() {
        let json = #"[{"kind":"mystery"}]"#
        XCTAssertThrowsError(try JSONDecoder().decode([SessionSummary].self, from: json.data(using: .utf8)!))
    }

    func testDisplayTitleFallsBackToRouteWhenCwdMissing() throws {
        let json = """
        [{"kind":"session","acpSessionId":"sess-x","spawns":[],\
        "startedAt":"2026-08-20T10:00:00.000Z","lastActivityAt":"2026-08-20T10:05:00.000Z",\
        "durationMs":0,"status":"ended","promptCount":0,"toolCallCount":0,\
        "route":"qodercli","model":null,"cwd":null,"representativeBridgePid":1}]
        """
        let sessions = try JSONDecoder().decode([SessionSummary].self, from: json.data(using: .utf8)!)
        XCTAssertEqual(sessions[0].displayTitle, "qodercli")
    }

    // MARK: - refresh() (network)

    func testRefreshTakesFirstEightAndPreloadsModelOptionsForDistinctRoutes() async {
        let sessionsJSON = (0..<10).map { i in
            """
            {"kind":"session","acpSessionId":"sess-\(i)","spawns":[],\
            "startedAt":"2026-08-20T10:00:00.000Z","lastActivityAt":"2026-08-20T10:05:00.000Z",\
            "durationMs":0,"status":"live","promptCount":0,"toolCallCount":0,\
            "route":"cursor","model":null,"cwd":null,"representativeBridgePid":\(i)}
            """
        }.joined(separator: ",")

        var modelsRequestCount = 0
        let model = makeModel { request in
            if request.url!.path == "/api/acp-conversation-sessions" {
                return Self.jsonResponse(request.url!, "[\(sessionsJSON)]")
            }
            XCTAssertEqual(request.url!.path, "/api/acp-models")
            XCTAssertEqual(request.url!.query, "route=cursor")
            modelsRequestCount += 1
            return Self.jsonResponse(
                request.url!,
                #"{"route":"cursor","models":["claude-3.5","gpt-5"],"source":"command","current":null}"#
            )
        }

        await model.refresh()

        XCTAssertEqual(model.sessions.count, 8)
        XCTAssertEqual(modelsRequestCount, 1, "distinct routes should be deduped/cached, not fetched per-row")
        XCTAssertEqual(model.modelOptions["cursor"], ["claude-3.5", "gpt-5"])
        XCTAssertNil(model.lastError)
    }

    func testRefreshSurfacesErrorAndLeavesSessionsEmptyOnFailure() async {
        MockURLProtocol.errorToThrow = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
        let client = ApiClient(session: MockURLProtocol.makeSession())
        let model = SessionsMenuModel(apiClient: client)

        await model.refresh()

        XCTAssertTrue(model.sessions.isEmpty)
        XCTAssertNotNil(model.lastError)
    }

    // MARK: - setModel

    func testSetModelPutsModelForSessionBridgePid() async throws {
        let session = try session(bridgePid: 42, acpSessionId: "sess-42", status: "live", route: "cursor")
        let model = makeModel { request in
            XCTAssertEqual(request.url!.path, "/api/acp-conversations/42/model")
            XCTAssertEqual(request.httpMethod, "PUT")
            let body = try JSONDecoder().decode([String: String].self, from: request.ofHttpBody())
            XCTAssertEqual(body["model"], "claude-3.5")
            return Self.jsonResponse(request.url!, #"{"ok":true,"bridgePid":42,"model":"claude-3.5"}"#)
        }

        try await model.setModel("claude-3.5", for: session)

        XCTAssertNil(model.lastError)
        XCTAssertNil(model.pendingBridgePid)
    }

    func testSetModelUpdatesMatchingSessionModelForMenuSelection() async throws {
        let model = makeModel { request in
            switch request.url!.path {
            case "/api/acp-conversation-sessions":
                return Self.jsonResponse(
                    request.url!,
                    """
                    [{"kind":"session","acpSessionId":"sess-42","spawns":[],\
                    "startedAt":"2026-08-20T10:00:00.000Z","lastActivityAt":"2026-08-20T10:05:00.000Z",\
                    "durationMs":0,"status":"live","promptCount":0,"toolCallCount":0,\
                    "route":"cursor","model":"claude-3.5","cwd":null,"representativeBridgePid":42}]
                    """
                )
            case "/api/acp-models":
                return Self.jsonResponse(
                    request.url!,
                    #"{"route":"cursor","models":["claude-3.5","gpt-5"],"source":"command","current":null}"#
                )
            case "/api/acp-conversations/42/model":
                return Self.jsonResponse(request.url!, #"{"ok":true,"bridgePid":42,"model":"gpt-5"}"#)
            default:
                return Self.jsonResponse(request.url!, status: 404, #"{"error":"unexpected"}"#)
            }
        }

        await model.refresh()
        XCTAssertEqual(model.sessions[0].model, "claude-3.5")

        try await model.setModel("gpt-5", for: model.sessions[0])

        XCTAssertEqual(model.sessions[0].model, "gpt-5")
        XCTAssertTrue(model.sessions[0].isSelectedModel("gpt-5"))
        XCTAssertFalse(model.sessions[0].isSelectedModel("claude-3.5"))
    }

    func testModelChoicesPrependsCurrentWhenMissingFromRouteList() async {
        let model = makeModel { request in
            if request.url!.path == "/api/acp-conversation-sessions" {
                return Self.jsonResponse(
                    request.url!,
                    """
                    [{"kind":"session","acpSessionId":"sess-1","spawns":[],\
                    "startedAt":"2026-08-20T10:00:00.000Z","lastActivityAt":"2026-08-20T10:05:00.000Z",\
                    "durationMs":0,"status":"live","promptCount":0,"toolCallCount":0,\
                    "route":"opencode","model":"litellm/deepseek-v4-flash-vision-exp","cwd":null,\
                    "representativeBridgePid":1}]
                    """
                )
            }
            return Self.jsonResponse(
                request.url!,
                #"{"route":"opencode","models":["opencode/big-pickle"],"source":"command","current":null}"#
            )
        }

        await model.refresh()
        let session = model.sessions[0]

        XCTAssertEqual(
            model.modelChoices(for: session),
            ["litellm/deepseek-v4-flash-vision-exp", "opencode/big-pickle"]
        )
        XCTAssertTrue(session.isSelectedModel("litellm/deepseek-v4-flash-vision-exp"))
    }

    func testModelChoicesDoesNotDuplicateCurrentModel() async {
        let model = makeModel { request in
            if request.url!.path == "/api/acp-conversation-sessions" {
                return Self.jsonResponse(
                    request.url!,
                    """
                    [{"kind":"session","acpSessionId":"sess-1","spawns":[],\
                    "startedAt":"2026-08-20T10:00:00.000Z","lastActivityAt":"2026-08-20T10:05:00.000Z",\
                    "durationMs":0,"status":"live","promptCount":0,"toolCallCount":0,\
                    "route":"opencode","model":"litellm/deepseek-v4-pro","cwd":null,\
                    "representativeBridgePid":1}]
                    """
                )
            }
            return Self.jsonResponse(
                request.url!,
                #"{"route":"opencode","models":["litellm/deepseek-v4-flash","litellm/deepseek-v4-pro"],"source":"command","current":null}"#
            )
        }

        await model.refresh()

        XCTAssertEqual(
            model.modelChoices(for: model.sessions[0]),
            ["litellm/deepseek-v4-flash", "litellm/deepseek-v4-pro"]
        )
    }

    func testSetModelFailurePublishesLastErrorAndClearsPending() async {
        let session = try! session(bridgePid: 42, acpSessionId: "sess-42", status: "live", route: "cursor")
        let model = makeModel { request in
            Self.jsonResponse(request.url!, status: 409, #"{"error":"conversation not live"}"#)
        }

        do {
            try await model.setModel("claude-3.5", for: session)
            XCTFail("expected error")
        } catch {
            XCTAssertNotNil(model.lastError)
            XCTAssertNil(model.pendingBridgePid)
        }
    }

    // MARK: - resume

    func testResumePostsToResumeEndpointForSessionBridgePid() async throws {
        let session = try session(bridgePid: 99, acpSessionId: "sess-99", status: "ended", route: "cursor")
        let model = makeModel { request in
            XCTAssertEqual(request.url!.path, "/api/acp-conversations/99/resume")
            XCTAssertEqual(request.httpMethod, "POST")
            return Self.jsonResponse(request.url!, #"{"ok":true,"sessionId":"sess-99"}"#)
        }

        try await model.resume(session)

        XCTAssertNil(model.lastError)
        XCTAssertNil(model.pendingBridgePid)
    }

    func testResumeFailurePublishesLastError() async {
        let session = try! session(bridgePid: 99, acpSessionId: nil, status: "ended", route: "cursor")
        let model = makeModel { request in
            Self.jsonResponse(request.url!, status: 409, #"{"error":"no session id"}"#)
        }

        do {
            try await model.resume(session)
            XCTFail("expected error")
        } catch {
            XCTAssertNotNil(model.lastError)
        }
    }

    // MARK: - observatoryURL

    func testObservatoryURLBuildsConversationDeepLink() throws {
        let session = try session(bridgePid: 4242, acpSessionId: "sess-abc", status: "live", route: "cursor")
        let model = SessionsMenuModel(apiClient: ApiClient())

        let url = model.observatoryURL(for: session, baseURL: URL(string: "http://127.0.0.1:8787")!)

        XCTAssertEqual(url.absoluteString, "http://127.0.0.1:8787/conversation.html?pid=4242")
    }

    // MARK: - fixtures

    private func session(
        bridgePid: Int,
        acpSessionId: String?,
        status: String,
        route: String
    ) throws -> SessionSummary {
        let json: String
        if let acpSessionId {
            json = """
            {"kind":"session","acpSessionId":"\(acpSessionId)","spawns":[],\
            "startedAt":"2026-08-20T10:00:00.000Z","lastActivityAt":"2026-08-20T10:05:00.000Z",\
            "durationMs":0,"status":"\(status)","promptCount":0,"toolCallCount":0,\
            "route":"\(route)","model":null,"cwd":null,"representativeBridgePid":\(bridgePid)}
            """
        } else {
            json = """
            {"kind":"singleton","spawn":{\
            "bridgePid":\(bridgePid),"backendPid":null,"route":"\(route)","cwd":null,\
            "mcpXcodeSessionId":null,"acpSessionId":null,\
            "startedAt":"2026-08-20T10:00:00.000Z","endedAt":null,\
            "lastActivityAt":"2026-08-20T10:05:00.000Z","status":"\(status)","durationMs":0,\
            "promptCount":0,"toolCallCount":0,"eventCount":0,"model":null}}
            """
        }
        return try JSONDecoder().decode(SessionSummary.self, from: json.data(using: .utf8)!)
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
