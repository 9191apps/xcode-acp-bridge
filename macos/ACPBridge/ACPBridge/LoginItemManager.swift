import Foundation
import ServiceManagement

/// Thin protocol over `SMAppService` so `LoginItemManager`'s register/
/// unregister decision is unit-testable without touching the real login-item
/// registry (which needs a properly signed, installed `.app` bundle and
/// isn't exercisable from `xcodebuild test`).
protocol LoginItemService {
    var status: SMAppService.Status { get }
    func register() throws
    func unregister() throws
}

extension SMAppService: LoginItemService {}

enum LoginItemAction: Equatable {
    case register
    case unregister
    case none
}

/// Registers/unregisters ACP Bridge as a login item via `SMAppService`,
/// backing the `openAtLogin` setting.
enum LoginItemManager {
    /// Pure decision: what to do given the desired toggle state and the
    /// login item's *current* registration status. Never calls into
    /// `SMAppService` itself — kept separate so it's unit-testable. Treats
    /// `.requiresApproval` (user hasn't approved it in System Settings yet)
    /// as "not really enabled" for the purposes of turning the toggle off.
    static func desiredAction(enabled: Bool, currentStatus: SMAppService.Status) -> LoginItemAction {
        switch (enabled, currentStatus) {
        case (true, .enabled):
            return .none
        case (true, _):
            return .register
        case (false, .enabled), (false, .requiresApproval):
            return .unregister
        case (false, _):
            return .none
        }
    }

    /// Applies `enabled` against `service` (real `SMAppService.mainApp` by
    /// default). Best-effort: registration can fail for reasons outside our
    /// control (e.g. the user declined it, or the running build isn't
    /// installed/signed in a way `SMAppService` accepts), so failures are
    /// swallowed rather than surfaced as a hard error — there's no dedicated
    /// UI surface for this in M2.
    static func apply(enabled: Bool, service: LoginItemService = SMAppService.mainApp) {
        switch desiredAction(enabled: enabled, currentStatus: service.status) {
        case .register:
            try? service.register()
        case .unregister:
            try? service.unregister()
        case .none:
            break
        }
    }
}
