import XCTest
import ServiceManagement
@testable import ACPBridge

/// Records calls instead of touching the real login-item registry —
/// `SMAppService.mainApp.register()` needs a properly signed, installed
/// `.app` bundle and isn't exercisable from `xcodebuild test`.
private final class MockLoginItemService: LoginItemService {
    var status: SMAppService.Status
    private(set) var registerCallCount = 0
    private(set) var unregisterCallCount = 0
    private let registerError: Error?

    init(status: SMAppService.Status, registerError: Error? = nil) {
        self.status = status
        self.registerError = registerError
    }

    func register() throws {
        registerCallCount += 1
        if let registerError { throw registerError }
    }

    func unregister() throws {
        unregisterCallCount += 1
    }
}

final class LoginItemManagerTests: XCTestCase {
    func testDesiredActionRegistersWhenEnablingAndNotRegistered() {
        XCTAssertEqual(LoginItemManager.desiredAction(enabled: true, currentStatus: .notRegistered), .register)
    }

    func testDesiredActionRegistersWhenEnablingAndRequiresApproval() {
        XCTAssertEqual(LoginItemManager.desiredAction(enabled: true, currentStatus: .requiresApproval), .register)
    }

    func testDesiredActionNoneWhenEnablingAndAlreadyEnabled() {
        XCTAssertEqual(LoginItemManager.desiredAction(enabled: true, currentStatus: .enabled), .none)
    }

    func testDesiredActionUnregistersWhenDisablingAndEnabled() {
        XCTAssertEqual(LoginItemManager.desiredAction(enabled: false, currentStatus: .enabled), .unregister)
    }

    func testDesiredActionUnregistersWhenDisablingAndRequiresApproval() {
        XCTAssertEqual(LoginItemManager.desiredAction(enabled: false, currentStatus: .requiresApproval), .unregister)
    }

    func testDesiredActionNoneWhenDisablingAndNotRegistered() {
        XCTAssertEqual(LoginItemManager.desiredAction(enabled: false, currentStatus: .notRegistered), .none)
    }

    func testApplyCallsRegisterWhenEnablingAndNotRegistered() {
        let mock = MockLoginItemService(status: .notRegistered)
        LoginItemManager.apply(enabled: true, service: mock)
        XCTAssertEqual(mock.registerCallCount, 1)
        XCTAssertEqual(mock.unregisterCallCount, 0)
    }

    func testApplyCallsUnregisterWhenDisablingAndEnabled() {
        let mock = MockLoginItemService(status: .enabled)
        LoginItemManager.apply(enabled: false, service: mock)
        XCTAssertEqual(mock.unregisterCallCount, 1)
        XCTAssertEqual(mock.registerCallCount, 0)
    }

    func testApplyIsNoOpWhenStateAlreadyMatches() {
        let mock = MockLoginItemService(status: .enabled)
        LoginItemManager.apply(enabled: true, service: mock)
        XCTAssertEqual(mock.registerCallCount, 0)
        XCTAssertEqual(mock.unregisterCallCount, 0)
    }

    func testApplySwallowsRegisterError() {
        struct Boom: Error {}
        let mock = MockLoginItemService(status: .notRegistered, registerError: Boom())
        // Must not throw or crash — registration failure has no dedicated UI
        // surface in M2, so it's intentionally best-effort.
        LoginItemManager.apply(enabled: true, service: mock)
        XCTAssertEqual(mock.registerCallCount, 1)
    }
}
