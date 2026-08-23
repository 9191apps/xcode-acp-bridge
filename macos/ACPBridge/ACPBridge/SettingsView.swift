import SwiftUI
import ServiceManagement

/// The app's `Settings { }` scene — the four M2 toggles from the design doc's
/// "Settings: menu bar / Dock visibility, login item" line. Persistence is
/// `@AppStorage` (two-way, immediate); side effects that persistence alone
/// doesn't cover (Dock policy, login-item registration) run from
/// `onChange`. `showMenuBarExtra` and `leaveServerRunningOnQuit` are read
/// directly off `UserDefaults` elsewhere (the `MenuBarExtra` scene, the quit
/// hook) so they need no `onChange` handler here.
struct SettingsView: View {
    @AppStorage(AppSettingsKeys.showMenuBarExtra) private var showMenuBarExtra = true
    @AppStorage(AppSettingsKeys.showDockIcon) private var showDockIcon = true
    @AppStorage(AppSettingsKeys.leaveServerRunningOnQuit) private var leaveServerRunningOnQuit = false
    @AppStorage(AppSettingsKeys.openAtLogin) private var openAtLogin = false

    var body: some View {
        Form {
            Section("Menu bar & Dock") {
                Toggle("Show menu bar icon", isOn: $showMenuBarExtra)
                Toggle("Show Dock icon", isOn: $showDockIcon)
                    .onChange(of: showDockIcon) { _, isShown in
                        NSApp.setActivationPolicy(isShown ? .regular : .accessory)
                    }
                if !showMenuBarExtra && !showDockIcon {
                    Text("Both are hidden — you won't be able to reopen this window without one of them.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
            Section("Backend") {
                Toggle("Leave acp-serve running after Quit", isOn: $leaveServerRunningOnQuit)
            }
            Section("Login") {
                Toggle("Open ACP Bridge at login", isOn: $openAtLogin)
                    .onChange(of: openAtLogin) { _, isEnabled in
                        LoginItemManager.apply(enabled: isEnabled)
                    }
            }
        }
        .formStyle(.grouped)
        .frame(width: 380)
        .fixedSize(horizontal: false, vertical: true)
        .onAppear {
            // Reconcile with the OS's actual login-item state (e.g. the user
            // removed it via System Settings > Login Items behind our back)
            // rather than trusting a possibly-stale stored value.
            openAtLogin = SMAppService.mainApp.status == .enabled
        }
    }
}

#Preview {
    SettingsView()
}
