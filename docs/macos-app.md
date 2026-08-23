# macOS App — install and use

Date: 2026-08-23  
Related: [design spec](superpowers/specs/2026-08-23-macos-app-shell-design.md) · [ACP bridge internals](./acp-bridge.md)

The **ACP Bridge** macOS app packages the existing Bun/TypeScript kernel (bridge + Observatory server) as a menu-bar + Dock app. Xcode talks to the compiled `acp-bridge` sidecar; the SwiftUI shell manages `acp-serve`, the menu, and an in-app WebView for the Observatory.

Developers can still use the CLI workflow (`bun run start`, `bun run acp-bridge`) from a git checkout — that path is unchanged.

## Build and install

**Prerequisites:** [Bun](https://bun.sh), Xcode 15+ (for the SwiftUI shell), macOS 14+.

From the repo root:

```bash
./scripts/build-app.sh
```

This script:

1. Runs `bun run compile:sidecars` — compiles `acp-bridge`, `acp-serve`, and resume helpers into `dist/sidecars/`.
2. Builds the SwiftUI shell with `xcodebuild` (Release).
3. Assembles `dist/ACP Bridge.app` with sidecars under `Contents/MacOS/`, Observatory static files under `Contents/Resources/public/`, and a bundled default config.

Optional output path:

```bash
./scripts/build-app.sh /Applications/ACP\ Bridge.app
```

Copy or drag the `.app` to `/Applications` for day-to-day use. The build is ad-hoc signed for local smoke testing; Developer ID signing and notarization are separate distribution steps.

## First launch

On launch the app:

1. Creates `~/Library/Application Support/ACP Bridge/` and `data/` if missing.
2. Copies `Contents/Resources/acp-bridge.config.default.json` → `~/Library/Application Support/ACP Bridge/acp-bridge.config.json` **only when the user config does not exist yet**.
3. Checks `http://127.0.0.1:8787/health`. If another process owns the port but returns a different product fingerprint, the app shows an error (no silent port fallback).
4. Otherwise starts bundled `acp-serve` with `ACP_BRIDGE_HOME`, `ACP_BRIDGE_CONFIG`, and `ACP_BRIDGE_RESOURCES` pointing at Application Support and the app bundle.

Writable state (events, route state, session models) lives under Application Support, not inside the signed bundle.

## Xcode ACP Agent registration

Register once in **Xcode → Settings → Intelligence → Add an ACP Agent**:

| Field | Value |
|---|---|
| Name | `ACP Bridge` |
| Executable | `/Applications/ACP Bridge.app/Contents/MacOS/acp-bridge` |
| Interpreter | *(empty)* |
| Arguments | *(empty)* |

Use **Copy Xcode Agent Paths** from the menu bar or Dock toolbar to paste the exact paths for your install location.

The packaged `acp-bridge` resolves config and data without inheriting the shell’s environment (Xcode spawns agents with a minimal env). Path discovery order: `ACP_BRIDGE_*` env vars → `.app` bundle layout → git `repoRoot()` for CLI/dev.

## Menu overview (M1–M3)

| Phase | Menu items |
|---|---|
| **M1** | Status header · **Next conversation** (Route ▸, Model ▸) · **Open Observatory** · **Copy Xcode Agent Paths** · **Settings…** · **Quit ACP Bridge** |
| **M2** | **Backend status** (per-route executable + auth) · Settings: menu bar / Dock visibility, login item, leave server running after Quit |
| **M3** | **Recent sessions** (≈8 rows) → per session: **Set model** ▸, **Resume in Terminal**, **Open in Observatory** (deep-links `/conversation.html?pid=`) |

The Dock window mirrors Observatory in a `WKWebView` at `http://127.0.0.1:8787`. Menu actions call the same HTTP APIs as the web UI (`/api/acp-route`, `/api/acp-conversation-sessions`, etc.).

## Backends and sandboxing

The app **does not bundle** OpenCode, Cursor Agent, or Qoder CLI. Install backends separately and point routes in `~/Library/Application Support/ACP Bridge/acp-bridge.config.json` (same shape as the repo config; `~` and env expansion apply).

The app is **non-sandboxed** (v1) so it can spawn user-installed agent binaries the same way the CLI bridge does.

## Developer workflow

From a git checkout, continue using:

```bash
bun run setup
bun run start          # dashboard on :8787
bun run acp-bridge     # Xcode agent via Bun + src/acp-bridge.ts
```

Set `ACP_BRIDGE_HOME`, `ACP_BRIDGE_CONFIG`, and `ACP_BRIDGE_RESOURCES` to test app-mode paths without the `.app` bundle.

## Bundle layout

```text
ACP Bridge.app/Contents/
  MacOS/
    ACPBridge          ← SwiftUI shell
    acp-bridge         ← Xcode-spawned ACP agent
    acp-serve          ← HTTP API + Observatory
    cursor-acp-resume
    qoder-acp-resume
  Resources/
    public/            ← Observatory static files
    acp-bridge.config.default.json
```
