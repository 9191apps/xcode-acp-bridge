# macOS App Shell — Design

**Date:** 2026-08-23  
**Status:** approved  
**Product shape:** Menu bar + Dock app; Observatory in in-app WebView; embedded Bun-compiled runtime  
**Approach:** SwiftUI shell + packaged `acp-bridge` / `acp-serve` binaries (not Tauri/Electron, not Swift rewrite of Observatory)

## Goal

Ship a macOS `.app` that:

1. Embeds the existing ACP bridge + dashboard runtime so users need not install Bun or clone the repo for day-to-day use.
2. Exposes a native menu (and optional Dock window chrome) to switch **next-conversation** ACP route and model, show backend status, and perform **session-level** Set model / Resume / open in Observatory.
3. Opens the existing web Observatory inside a `WKWebView` (same UI and APIs as today).

CLI / source workflow (`bun run start`, `bun run acp-bridge`) remains supported for developers.

## Decisions (from brainstorming)

| Topic | Choice |
|---|---|
| UI shape | B+: lightweight native controls + Observatory as WebView in-app |
| Runtime | B: embed compiled bridge/serve inside the `.app` |
| Menu scope | C: next conversation + ops + recent-session actions |
| Presence | C: both MenuBarExtra and Dock; Settings can hide either |
| Implementation | 1: SwiftUI shell + Bun `--compile` sidecars |

## Non-goals (v1 App)

- Sandboxed App that cannot spawn user-installed agents (prefer **non-sandbox** Developer ID build first; sandbox is a later research track).
- Auto-writing Xcode Intelligence ACP Agent preferences (no stable public API).
- Bundling OpenCode / Cursor Agent / Qoder CLI.
- Rewriting Observatory business logic in Swift.
- Silent port fallback when `8787` is taken by something else.
- Replacing the git/Bun developer workflow.

## Architecture

```text
┌─ ACP Bridge.app ─────────────────────────────────────┐
│  SwiftUI Shell                                        │
│  · MenuBarExtra (route / model / recent sessions)     │
│  · Dock main window → WKWebView → 127.0.0.1:8787      │
│  · Settings: menu bar / Dock visibility, login item   │
│                                                       │
│  Contents/MacOS/                                      │
│  · ACPBridge          ← GUI shell                     │
│  · acp-bridge         ← Xcode-spawned ACP agent       │
│  · acp-serve          ← HTTP API + static Observatory │
│  Contents/Resources/                                  │
│  · public/ · acp-bridge.config.default.json           │
└───────────────────────────────────────────────────────┘
         │ HTTP                     │ stdio ACP
         ▼                          ▼
   Menu / WebView              Xcode Intelligence
         │
         ▼
   ~/Library/Application Support/ACP Bridge/
     config · data/ (events, route state, session models)
```

**Principles**

1. Protocol tee, routing, models, shims, and storage stay in the Bun/TS kernel.
2. Xcode talks only to packaged `acp-bridge` over stdio — the Swift shell does not proxy JSON-RPC.
3. Writable state lives under Application Support, not inside the signed bundle.
4. Menu and WebView share the same HTTP APIs.
5. Source CLI path remains first-class for development and tests.

## Bundle layout and paths

**Read-only (inside `.app`)**

```text
ACP Bridge.app/Contents/
  MacOS/
    ACPBridge
    acp-bridge
    acp-serve
  Resources/
    public/
    acp-bridge.config.default.json
```

Resume helpers (`cursor-acp-resume` / `qoder-acp-resume`) should be compiled into the packaged runtime or as sibling binaries under `MacOS/`, so Terminal resume does not depend on an external Bun interpreting `.ts` files from a git checkout.

**Writable (user)**

```text
~/Library/Application Support/ACP Bridge/
  acp-bridge.config.json
  data/
```

On first launch, copy default config into Application Support if missing.

**Environment and discovery**

| Variable | Purpose |
|---|---|
| `ACP_BRIDGE_HOME` | Application Support root |
| `ACP_BRIDGE_CONFIG` | Path to user config JSON |
| `ACP_BRIDGE_RESOURCES` | `Contents/Resources` (public + defaults) |

The Swift shell sets these when spawning `acp-serve`.

**Critical:** Xcode spawns `acp-bridge` with a minimal environment and will **not** inherit the shell’s variables. Packaged `acp-bridge` must resolve paths without relying on the shell:

1. If `ACP_BRIDGE_*` are set, use them (dev / tests / serve child).
2. Else if the executable lives inside `*.app/Contents/MacOS/`, treat that app bundle as the install root: `Resources` beside `MacOS`, and default home to `~/Library/Application Support/ACP Bridge/`.
3. Else fall back to today’s git `repoRoot()` behavior for CLI/dev.

Both sidecars share this resolution so menu-written route state and Xcode-spawned agent read the same config/data.

**Xcode registration (once, manual)**

| Field | Value |
|---|---|
| Name | `ACP Bridge` |
| Executable | `…/ACP Bridge.app/Contents/MacOS/acp-bridge` |
| Interpreter | *(empty)* |
| Arguments | *(empty)* |

Shell provides Copy paths / Reveal in Finder / short Settings → Intelligence instructions. No automatic Xcode preference mutation in v1.

**Backends**  
`opencode` / `agent` / `qodercli` remain user-installed; config keeps `~` / env expansion. App does not bundle them.

**Port**  
Default `127.0.0.1:8787`. If occupied by a non-product process: surface error; do not silently bind elsewhere (matches current server behavior). If health already identifies this product: reuse.

## Menu information architecture

```text
ACP Bridge ●/○
├── Next conversation
│   ├── Route ▸
│   └── Model ▸
├── Recent sessions (≈5–10 from conversation-sessions API)
│   └── <row>
│       ├── Set model ▸
│       ├── Resume in Terminal
│       └── Open in Observatory
├── Open Observatory
├── Backend status
├── Copy Xcode Agent paths
├── Settings…
└── Quit
```

Dock main window: optional toolbar mirrors Next route/model; center is `WKWebView`; optional “Open in Browser”.

### API mapping

| Action | API |
|---|---|
| Next route/model | `GET` / `PUT /api/acp-route` |
| Model lists | `GET /api/acp-models?route=` |
| Recent sessions | `GET /api/acp-conversation-sessions` |
| Session set model | `PUT /api/acp-conversations/:bridgePid/model` |
| Resume | `POST /api/acp-conversations/:bridgePid/resume` |
| Health | `GET /health` |

**Small kernel additions (allowed)**

- `GET /api/app/status` — health, current route/model, per-route binary presence, auth heuristics (reuse setup-check logic).
- Observatory deep-link query (`?pid=` / `?session=`) if not already supported, for “Open in Observatory”.

Swift must not write `acp-route.json` directly.

**Semantics (surface in UI copy)**

- Next conversation route/model applies only to the **next** Xcode New Conversation spawn.
- Session Set model: live inject when process alive; ended + `sessionId` → ledger for next resume; `spawn-arg` routes keep existing “every spawn may carry `--model`” caveats.

## Delivery phases

| Phase | Scope |
|---|---|
| **M1** | Package layout + env; `acp-serve` lifecycle; Next route/model menu; Open Observatory WebView; Copy Xcode paths |
| **M2** | Backend status; Settings (menu bar / Dock visibility, login item via `SMAppService`); Quit policy |
| **M3** | Recent sessions → Set model / Resume / Open in Observatory (+ deep link) |

## Shell lifecycle and errors

1. Launch → ensure Application Support + default config.
2. If `:8787` is already this product → reuse; if foreign occupant → error.
3. Else spawn `acp-serve` with env; poll `/health`; on timeout disable mutating menu actions.
4. WebView loads only after health OK; failure page with Retry.
5. Quit: by default terminate `acp-serve`; never kill Xcode-owned `acp-bridge` processes. Optional setting: “Leave server running after Quit” (default off).

**User-visible errors:** red status for serve/port failures; alerts / disabled items for 4xx (unknown route, no session id); yellow Backend status for missing binary / not logged in without blocking route selection; WebView error page instead of blank.

## Repository layout

```text
xcode-acp-bridge/           # existing Bun kernel + tests + CLI
macos/ACPBridge/            # Xcode / SwiftUI shell project
scripts/build-app.sh        # compile sidecars → copy into .app → optional codesign
```

## Testing

| Layer | What |
|---|---|
| Kernel (`bun test`) | App-mode paths via `ACP_BRIDGE_*`; `/api/app/status`; deep-link query if added |
| Shell (XCTest) | Menu view-model from fixture JSON; port-occupancy branches; no live Xcode |
| Manual M1–M3 | Install to `/Applications` → register Agent → menu switch → New Conversation → WebView → session model / resume |

## Signing and distribution (v1 intent)

- Distribute as Developer ID signed + notarized `.dmg` / zip when ready for external users.
- Start **non-sandboxed** so spawning `~/.local/bin/agent` etc. works like the CLI bridge today.
- GitHub Releases can ship the `.app` alongside continued source tags.

## Resolved decisions (formerly open questions)

1. **Sidecar layout:** **Two sidecars** (`acp-bridge` + `acp-serve`) plus compiled resume helpers (`cursor-acp-resume`, `qoder-acp-resume`) under `Contents/MacOS/`. Implemented in `scripts/compile-sidecars.ts` and `scripts/build-app.sh` — not a single combined `agent|serve` binary.
2. **Health fingerprint:** `GET /health` returns `{ ok, product: "xcode-acp-bridge", version }`. The Swift shell reuses an existing serve on `:8787` only when `product` matches; otherwise it surfaces `portOccupiedByOther`.
3. **Leave server running after Quit:** Shipped in **M2** (`SettingsView` toggle, default off). On Quit the shell terminates only the `acp-serve` it spawned; never Xcode-owned `acp-bridge` processes.

## Done when

- Design reviewed and approved.
- Implementation plan covers M1→M3 with kernel path/env work before shell UI.
- M1 manual path works: App launches serve, menu sets next route/model, Xcode uses packaged `acp-bridge`, WebView shows Observatory.
