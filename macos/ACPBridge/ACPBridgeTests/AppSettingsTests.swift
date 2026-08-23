import XCTest
@testable import ACPBridge

final class AppSettingsTests: XCTestCase {
    private let suiteName = "AppSettingsTests"
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    func testRegisterDefaultsMatchesBrief() {
        AppSettingsKeys.registerDefaults(in: defaults)

        XCTAssertTrue(defaults.bool(forKey: AppSettingsKeys.showMenuBarExtra))
        XCTAssertTrue(defaults.bool(forKey: AppSettingsKeys.showDockIcon))
        XCTAssertFalse(defaults.bool(forKey: AppSettingsKeys.leaveServerRunningOnQuit))
        XCTAssertFalse(defaults.bool(forKey: AppSettingsKeys.openAtLogin))
    }

    func testRegisterDefaultsDoesNotOverrideAlreadyStoredValue() {
        // Registration defaults must never clobber a value the user (or a
        // prior launch) already explicitly set.
        defaults.set(false, forKey: AppSettingsKeys.showDockIcon)
        defaults.set(true, forKey: AppSettingsKeys.leaveServerRunningOnQuit)

        AppSettingsKeys.registerDefaults(in: defaults)

        XCTAssertFalse(defaults.bool(forKey: AppSettingsKeys.showDockIcon))
        XCTAssertTrue(defaults.bool(forKey: AppSettingsKeys.leaveServerRunningOnQuit))
    }
}
