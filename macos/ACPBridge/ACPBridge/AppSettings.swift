import Foundation

/// `UserDefaults` keys for the four M2 settings toggles. Views bind to these
/// directly via `@AppStorage(AppSettingsKeys.x)` (two-way, auto-persisted,
/// auto-republishing SwiftUI); non-View call sites that can't use
/// `@AppStorage` (the `AppDelegate` quit hook, the initial dock-icon policy
/// at launch) read the same keys straight off `UserDefaults.standard`.
enum AppSettingsKeys {
    static let showMenuBarExtra = "showMenuBarExtra"
    static let showDockIcon = "showDockIcon"
    static let leaveServerRunningOnQuit = "leaveServerRunningOnQuit"
    static let openAtLogin = "openAtLogin"

    /// Registers the brief's defaults (`showMenuBarExtra`/`showDockIcon`
    /// true, `leaveServerRunningOnQuit`/`openAtLogin` false) as *registration
    /// defaults* — i.e. they're what `UserDefaults` returns until the user
    /// (or a prior launch) writes an explicit value, and never overwrite an
    /// already-stored value. Must run before any `@AppStorage` binding or
    /// direct `UserDefaults` read of these keys, so call it from
    /// `ACPBridgeApp.init()`.
    static func registerDefaults(in defaults: UserDefaults = .standard) {
        defaults.register(defaults: [
            showMenuBarExtra: true,
            showDockIcon: true,
            leaveServerRunningOnQuit: false,
            openAtLogin: false,
        ])
    }
}
