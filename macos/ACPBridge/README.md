# ACP Bridge (macOS shell)

SwiftUI shell that starts the bundled `acp-serve` sidecar and hosts the
existing Observatory dashboard in an in-app `WKWebView`. Non-sandboxed,
macOS 14+. Bundle id `apps.9191.ACPBridge`.

## Project layout

- `project.yml` — [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec. Regenerate the
  checked-in `.xcodeproj` with:

  ```bash
  brew install xcodegen   # if needed
  cd macos/ACPBridge && xcodegen generate
  ```

- `ACPBridge/` — app target sources
  - `AppMain.swift` — `@main` App + `AppDelegate` (stops `acp-serve` on Quit)
  - `ServeProcessManager.swift` — health-check / spawn / shutdown lifecycle
    for the bundled `acp-serve`, plus the pure `ServeDecisionMaker` used to
    tell "our server" apart from a foreign process on `:8787`
  - `ApiClient.swift` — tiny `/health` client
  - `ObservatoryWebView.swift` — `WKWebView` wrapper
  - `ContentView.swift` — window UI + "Copy Xcode Agent Paths"
- `ACPBridgeTests/` — XCTest unit tests (health decode, port-occupied
  decision matrix, agent path formatting) using a `URLProtocol` mock —
  no live server or GUI automation required.

## Build

Open `ACPBridge.xcodeproj` in Xcode (⌘R to run), or from the command line:

```bash
cd macos/ACPBridge
xcodebuild -project ACPBridge.xcodeproj -scheme ACPBridge \
  -configuration Release -derivedDataPath build build
xcodebuild -project ACPBridge.xcodeproj -scheme ACPBridge test
```

A **post-build** phase (`Embed ACP sidecars`) runs `scripts/embed-sidecars-into-app.sh`: it compiles (or reuses) Bun sidecars and copies them plus `public/` and the default config into the built `.app`. After ⌘R, `Contents/MacOS/` should contain `ACPBridge`, `acp-bridge`, `acp-serve`, and the resume helpers.

Requires `bun` on PATH (or `~/.bun/bin`). Set `ACP_FORCE_COMPILE=1` in the scheme environment to force a full sidecar rebuild.

`scripts/build-app.sh` (repo root) runs the same Xcode build and copies the result to `dist/ACP Bridge.app`.

## Manual smoke test

1. `./scripts/build-app.sh`
2. `open "dist/ACP Bridge.app"`
3. Confirm a window opens showing "Starting…" then the Observatory list view.
4. `curl http://127.0.0.1:8787/health` → `{"ok":true,"product":"xcode-acp-bridge",...}`.
5. Click "Copy Xcode Agent Paths", paste somewhere — expect the `.../Contents/MacOS/acp-bridge` executable path plus an empty Interpreter line.
6. Quit the app — `acp-serve` should exit too (check with `ps aux | grep acp-serve`).
7. Port-occupied path: start something else listening on `:8787`, relaunch
   the app — it should NOT spawn `acp-serve` and the window should show the
   error page with a Retry button instead of the WebView.
