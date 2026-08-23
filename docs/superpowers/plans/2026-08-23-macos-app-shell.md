# macOS App Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a macOS `.app` (SwiftUI shell + Bun-compiled `acp-bridge` / `acp-serve`) that embeds the ACP runtime, switches next-conversation route/model from a menu, and opens Observatory in a WebView — without requiring users to install Bun.

**Architecture:** Kernel gains App-mode path discovery (`ACP_BRIDGE_*` env + `.app` layout + Application Support). Two compiled sidecars live in `Contents/MacOS/`. SwiftUI shell owns process lifecycle, MenuBarExtra, Dock WebView, and calls existing HTTP APIs. Deliver in M1 → M2 → M3 per the design spec.

**Tech Stack:** Bun, TypeScript, Hono, bun:test; SwiftUI (macOS 14+), WKWebView, SMAppService; `bun build --compile`.

**Spec:** [2026-08-23-macos-app-shell-design.md](../specs/2026-08-23-macos-app-shell-design.md)

## Global Constraints

- Do not sandbox the v1 App (must spawn user `~/.local/bin/agent` etc.)
- Do not auto-write Xcode Intelligence preferences
- Do not bundle opencode / Cursor / Qoder CLIs
- Do not rewrite Observatory in Swift — WebView loads existing `public/`
- Port stays `127.0.0.1:8787`; no silent port fallback
- CLI / `bun run start` / `bun test` keep working for developers
- `defaultRoute` remains `"opencode"` unless user changes config
- Work on current branch; commit after each task
- Prefer TDD for kernel TypeScript; XCTest for shell view-models

## File map

| File | Responsibility |
|------|----------------|
| `src/acp/paths.ts` | Resolve home / resources / config / data roots (env → app bundle → git repo) |
| `src/acp/config.ts` | Use `paths.ts` instead of bare `repoRoot()` for config + relative paths |
| `src/index.ts` | Serve static from resources root; expose product health fields |
| `src/dashboard/acp-routes.ts` | `GET /api/app/status`; keep existing route/model/resume APIs |
| `src/setup-check.ts` | Reuse detectors inside `/api/app/status` |
| `src/dashboard/acp-routes.ts` (resume) | Resolve resume helpers via `paths` / packaged siblings, not only `repoRoot()/src/...` |
| `tests/acp-paths.test.ts` | Path discovery unit tests |
| `tests/acp-app-status.test.ts` | `/api/app/status` + health product id |
| `scripts/compile-sidecars.ts` | `bun build --compile` for agent + serve (+ resume helpers) |
| `scripts/build-app.sh` | Assemble `.app` Contents from sidecars + `public/` + default config |
| `macos/ACPBridge/` | Xcode SwiftUI project (shell) |
| `public/list.js` / `detail.js` | Optional: honor `?pid=` on list→detail already exists; ensure list deep-link selects row if needed |
| `README.md`, `docs/acp-bridge.md` | Document App install + Xcode paths |

## Phases vs tasks

| Phase | Tasks | Outcome |
|-------|-------|---------|
| Kernel foundation | 1–4 | App-mode paths, health fingerprint, `/api/app/status`, static/resources |
| Packaging | 5–6 | Compile sidecars + assemble `.app` skeleton (even before full Swift UI) |
| M1 shell | 7–8 | Serve lifecycle, Next route/model menu, WebView, Copy paths |
| M2 | 9 | Backend status, Settings (menu/Dock/login item), Quit policy |
| M3 | 10 | Recent sessions Set model / Resume / Open in Observatory |
| Docs | 11 | README + bridge docs |

Stop after Task 8 for a usable M1 demo; continue for M2/M3.

---

### Task 1: App path discovery module

**Files:**
- Create: `src/acp/paths.ts`
- Create: `tests/acp-paths.test.ts`
- Modify: `src/acp/config.ts` (switch `repoRoot` / `defaultConfigPath` / `resolveConfigPath` to use paths)

**Interfaces:**
- Consumes: `process.env`, `process.execPath`, `os.homedir()`, `import.meta.dir`
- Produces:
  - `export type AcpPathLayout = { mode: "env" | "app" | "repo"; home: string; resources: string; configPath: string; }`
  - `export function resolveAcpPathLayout(opts?: { execPath?: string; env?: NodeJS.ProcessEnv; repoFallback?: string }): AcpPathLayout`
  - `export function repoRoot(): string` — keep export for callers; implement as `resolveAcpPathLayout().mode === "repo" ? … : home` **or** deprecate and re-export `layout.home` carefully (see Step 3)
  - Prefer: keep `repoRoot()` for **git checkout root** only; new code uses `resolveAcpPathLayout()`

- [ ] **Step 1: Write failing tests**

Create `tests/acp-paths.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAcpPathLayout } from "../src/acp/paths";

describe("resolveAcpPathLayout", () => {
  test("env ACP_BRIDGE_HOME + CONFIG + RESOURCES wins", () => {
    const layout = resolveAcpPathLayout({
      env: {
        ACP_BRIDGE_HOME: "/tmp/acp-home",
        ACP_BRIDGE_CONFIG: "/tmp/acp-home/acp-bridge.config.json",
        ACP_BRIDGE_RESOURCES: "/tmp/acp-res",
      },
      repoFallback: "/repo",
    });
    expect(layout.mode).toBe("env");
    expect(layout.home).toBe("/tmp/acp-home");
    expect(layout.resources).toBe("/tmp/acp-res");
    expect(layout.configPath).toBe("/tmp/acp-home/acp-bridge.config.json");
  });

  test("execPath inside Fake.app/Contents/MacOS → app mode", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-app-"));
    const macOS = path.join(root, "Fake.app", "Contents", "MacOS");
    const resources = path.join(root, "Fake.app", "Contents", "Resources");
    fs.mkdirSync(macOS, { recursive: true });
    fs.mkdirSync(resources, { recursive: true });
    const execPath = path.join(macOS, "acp-bridge");
    fs.writeFileSync(execPath, "");
    const layout = resolveAcpPathLayout({
      execPath,
      env: {},
      repoFallback: "/should-not-use",
    });
    expect(layout.mode).toBe("app");
    expect(layout.resources).toBe(resources);
    expect(layout.home).toBe(path.join(os.homedir(), "Library", "Application Support", "ACP Bridge"));
    expect(layout.configPath).toBe(path.join(layout.home, "acp-bridge.config.json"));
  });

  test("otherwise uses repoFallback", () => {
    const layout = resolveAcpPathLayout({
      execPath: "/usr/bin/bun",
      env: {},
      repoFallback: "/Users/dev/xcode-acp-bridge",
    });
    expect(layout.mode).toBe("repo");
    expect(layout.home).toBe("/Users/dev/xcode-acp-bridge");
    expect(layout.resources).toBe("/Users/dev/xcode-acp-bridge");
    expect(layout.configPath).toBe("/Users/dev/xcode-acp-bridge/acp-bridge.config.json");
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `bun test tests/acp-paths.test.ts`

Expected: FAIL (module missing)

- [ ] **Step 3: Implement `src/acp/paths.ts`**

```typescript
import os from "node:os";
import path from "node:path";

export type AcpPathLayout = {
  mode: "env" | "app" | "repo";
  home: string;
  resources: string;
  configPath: string;
};

function appSupportHome(): string {
  return path.join(os.homedir(), "Library", "Application Support", "ACP Bridge");
}

/** If execPath is …/Something.app/Contents/MacOS/<bin>, return Contents dir. */
export function contentsDirFromExecPath(execPath: string): string | null {
  const macOSDir = path.dirname(execPath);
  if (path.basename(macOSDir) !== "MacOS") return null;
  const contents = path.dirname(macOSDir);
  if (path.basename(contents) !== "Contents") return null;
  return contents;
}

export function resolveAcpPathLayout(opts?: {
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  repoFallback?: string;
}): AcpPathLayout {
  const env = opts?.env ?? process.env;
  const repoFallback =
    opts?.repoFallback ?? path.resolve(import.meta.dir, "../..");

  const homeEnv = env.ACP_BRIDGE_HOME;
  const configEnv = env.ACP_BRIDGE_CONFIG;
  const resourcesEnv = env.ACP_BRIDGE_RESOURCES;
  if (homeEnv || configEnv || resourcesEnv) {
    const home = homeEnv ?? appSupportHome();
    return {
      mode: "env",
      home,
      resources: resourcesEnv ?? home,
      configPath: configEnv ?? path.join(home, "acp-bridge.config.json"),
    };
  }

  const execPath = opts?.execPath ?? process.execPath;
  const contents = contentsDirFromExecPath(execPath);
  if (contents) {
    const home = appSupportHome();
    return {
      mode: "app",
      home,
      resources: path.join(contents, "Resources"),
      configPath: path.join(home, "acp-bridge.config.json"),
    };
  }

  return {
    mode: "repo",
    home: repoFallback,
    resources: repoFallback,
    configPath: path.join(repoFallback, "acp-bridge.config.json"),
  };
}
```

- [ ] **Step 4: Wire `config.ts`**

- Change `defaultConfigPath()` to `resolveAcpPathLayout().configPath`.
- Change `resolveConfigPath` relative joins to use `layout.home` (not `repoRoot()`), so App Support relative `./data/...` lands under Application Support.
- Keep exporting `repoRoot()` as `path.resolve(import.meta.dir, "../..")` for scripts that truly mean the git repo (setup, registrationInfo for CLI). Document in JSDoc: “git checkout root; for runtime data use resolveAcpPathLayout()”.

Update any `repoRoot()` callers that mean “runtime home” (resume script paths, registration for **App** later) in later tasks — for this task, only config load paths.

- [ ] **Step 5: Run tests — expect PASS**

Run: `bun test tests/acp-paths.test.ts tests/acp-config.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/acp/paths.ts src/acp/config.ts tests/acp-paths.test.ts
git commit -m "$(cat <<'EOF'
feat: resolve ACP paths for env, app bundle, and repo modes

EOF
)"
```

---

### Task 2: Product health fingerprint + `/api/app/status`

**Files:**
- Modify: `src/index.ts`
- Modify: `src/dashboard/acp-routes.ts`
- Modify: `src/setup-check.ts` (export helpers if needed)
- Create: `tests/acp-app-status.test.ts`
- Modify: `tests/acp-dashboard.test.ts` only if health assertion conflicts

**Interfaces:**
- Consumes: `resolveAcpPathLayout`, `loadAcpBridgeConfig`, `detectBackendBinary`, `checkAgentAuth`, `checkQodercliAuth`, `routeResponse`
- Produces:
  - `GET /health` JSON includes `{ ok: true, product: "xcode-acp-bridge", version: string }`
  - `GET /api/app/status` →
    ```typescript
    {
      ok: boolean;
      product: "xcode-acp-bridge";
      version: string;
      route: string;
      model: string | null;
      routes: string[];
      backends: Array<{
        name: string;
        command: string;
        executable: boolean;
        auth?: { ok: boolean; authenticated: boolean; detail: string };
      }>;
      layoutMode: "env" | "app" | "repo";
    }
    ```

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { createAcpDashboardApp } from "../src/dashboard/acp-routes";
// use existing testConfig() / store helpers from acp-dashboard.test.ts pattern

test("GET /api/app/status returns product and route", async () => {
  const app = /* createAcpDashboardApp with testConfig */;
  const res = await app.request("http://127.0.0.1/api/app/status");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.product).toBe("xcode-acp-bridge");
  expect(body.routes).toContain("opencode");
  expect(typeof body.route).toBe("string");
  expect(Array.isArray(body.backends)).toBe(true);
});
```

Also add a small test or script assertion that `/health` includes `product` once `index.ts` is updated (can hit via `app.get("/health")` if moved into dashboard app, **or** keep health on `index.ts` and test with a thin export). Prefer moving enhanced health onto the Hono app used by both:

```typescript
// in createAcpDashboardApp:
app.get("/health", (c) =>
  c.json({ ok: true, product: "xcode-acp-bridge", version: packageVersion() }),
);
```

Then `index.ts` can omit duplicate or call through. If `index.ts` already defines `/health`, replace it to match.

Read `package.json` version via `import pkg from "../../package.json"` or hardcode reading file from layout.resources / repo.

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test tests/acp-app-status.test.ts`

Expected: FAIL (404 or missing fields)

- [ ] **Step 3: Implement status endpoint**

In `acp-routes.ts`, add `GET /api/app/status` that:

1. Builds `routeResponse(config)`
2. For each route name, `detectBackendBinary(name, config.routes[name].command)` + `hasExecutable`
3. For `cursor` / agent basename → `checkAgentAuth`; for `qodercli` → `checkQodercliAuth`; opencode omit auth or light check
4. Includes `layoutMode: resolveAcpPathLayout().mode`

Update `/health` body as above.

- [ ] **Step 4: Run — expect PASS**

Run: `bun test tests/acp-app-status.test.ts tests/acp-dashboard.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/dashboard/acp-routes.ts src/setup-check.ts tests/acp-app-status.test.ts
git commit -m "$(cat <<'EOF'
feat: add product health fingerprint and /api/app/status

EOF
)"
```

---

### Task 3: Serve static assets from `layout.resources`

**Files:**
- Modify: `src/index.ts`
- Modify: tests if any cover static; else add `tests/acp-static-root.test.ts` that unit-tests a small helper

**Interfaces:**
- Produces: `export function publicDir(): string` in `paths.ts` → `path.join(resolveAcpPathLayout().resources, "public")` (repo mode: `<repo>/public`)

- [ ] **Step 1: Add helper + test**

```typescript
test("publicDir joins resources/public", () => {
  // with env RESOURCES=/tmp/res → /tmp/res/public
});
```

- [ ] **Step 2: Change `src/index.ts`**

Replace:

```typescript
app.use("/*", serveStatic({ root: "./public" }));
```

with:

```typescript
import { publicDir } from "./acp/paths";
app.use("/*", serveStatic({ root: publicDir() }));
```

Ensure `publicDir()` is absolute (Hono/Bun serveStatic is cwd-sensitive).

- [ ] **Step 3: Run `bun test` + quick manual `bun run start` and `curl -sI http://127.0.0.1:8787/`**

Expected: tests PASS; index HTML 200

- [ ] **Step 4: Commit**

```bash
git add src/acp/paths.ts src/index.ts tests/acp-paths.test.ts
git commit -m "$(cat <<'EOF'
fix: serve Observatory static files from resolved resources root

EOF
)"
```

---

### Task 4: Resume helpers resolve under packaged layout

**Files:**
- Modify: `src/dashboard/acp-routes.ts` (`cursorAcpResumeScriptPath`, `qoderAcpResumeScriptPath`, `buildResumeLaunchArgs`)
- Modify: `tests/acp-spawn-args.test.ts`

**Interfaces:**
- Produces: helpers return path to:
  1. `path.join(layout.resources, "bin", "cursor-acp-resume")` if executable exists, else
  2. `path.join(contents/MacOS, "cursor-acp-resume")` when in app mode, else
  3. existing `path.join(repoRoot(), "src", "acp", "cursor-acp-resume.ts")` for repo/dev

For M1 packaging (Task 5), compile resume TS to sibling binaries named `cursor-acp-resume` and `qoder-acp-resume`. `buildResumeLaunchArgs` when target is compiled binary: `{ bin: helperPath, argv: ["--agent", …] }` (no `process.execPath` prefix). When target is `.ts`: keep `{ bin: process.execPath, argv: [script, …] }`.

- [ ] **Step 1: Extend spawn-args / resume tests for app-layout fake paths**

Use temp dir mimicking `Contents/MacOS/cursor-acp-resume` + set `execPath` via injecting a testable `resolveResumeLaunch` function **or** set `ACP_BRIDGE_RESOURCES` + drop a fake executable file.

- [ ] **Step 2: Implement path selection + argv shape**

- [ ] **Step 3: `bun test tests/acp-spawn-args.test.ts` — PASS

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: resolve ACP resume helpers for packaged app binaries

EOF
)"
```

---

### Task 5: Compile sidecars script

**Files:**
- Create: `scripts/compile-sidecars.ts`
- Modify: `package.json` scripts: `"compile:sidecars": "bun run scripts/compile-sidecars.ts"`
- Create: `dist/sidecars/.gitkeep` or gitignore `dist/`

**Interfaces:**
- Produces binaries under `dist/sidecars/`:
  - `acp-bridge` from `src/acp-bridge.ts`
  - `acp-serve` from `src/index.ts`
  - `cursor-acp-resume` from `src/acp/cursor-acp-resume.ts`
  - `qoder-acp-resume` from `src/acp/qoder-acp-resume.ts`

- [ ] **Step 1: Implement compile script**

```typescript
#!/usr/bin/env bun
import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";

const out = path.join(import.meta.dir, "..", "dist", "sidecars");
fs.mkdirSync(out, { recursive: true });

const targets = [
  { entry: "src/acp-bridge.ts", outfile: "acp-bridge" },
  { entry: "src/index.ts", outfile: "acp-serve" },
  { entry: "src/acp/cursor-acp-resume.ts", outfile: "cursor-acp-resume" },
  { entry: "src/acp/qoder-acp-resume.ts", outfile: "qoder-acp-resume" },
] as const;

for (const t of targets) {
  const outfile = path.join(out, t.outfile);
  await $`bun build --compile ${t.entry} --outfile ${outfile}`;
  console.log("compiled", outfile);
}
```

- [ ] **Step 2: Run compile**

Run: `bun run compile:sidecars`

Expected: four binaries in `dist/sidecars/`; `./dist/sidecars/acp-serve` starts (kill after `/health` shows product)

Smoke:

```bash
ACP_BRIDGE_HOME=/tmp/acp-smoke ACP_BRIDGE_RESOURCES=$PWD \
  ./dist/sidecars/acp-serve &
sleep 1
curl -s http://127.0.0.1:8787/health
kill %1
```

Ensure `/tmp/acp-smoke/acp-bridge.config.json` exists (copy from repo) before smoke.

- [ ] **Step 3: Add `dist/` to `.gitignore` if not present**

- [ ] **Step 4: Commit script + gitignore (not binaries)**

```bash
git commit -m "$(cat <<'EOF'
chore: add bun compile script for app sidecars

EOF
)"
```

---

### Task 6: `build-app.sh` assembles `.app` skeleton

**Files:**
- Create: `scripts/build-app.sh`
- Create: `macos/ACPBridge/` minimal Xcode project **or** stub `macos/ACPBridge/README.md` stating “open in Xcode in Task 7” if generating xcodeproj by hand is preferred in Task 7
- Create: default config copy path: use repo `acp-bridge.config.json` as `Resources/acp-bridge.config.default.json`

- [ ] **Step 1: Write `scripts/build-app.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/dist/ACP Bridge.app}"
bun run --cwd "$ROOT" compile:sidecars
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/public"
# Placeholder executable until Swift build provides ACPBridge — copy a tiny shell wrapper for CI layout check:
cat > "$APP/Contents/MacOS/ACPBridge" <<'EOF'
#!/bin/bash
echo "Swift shell not built yet; use Xcode to build ACPBridge" >&2
exit 1
EOF
chmod +x "$APP/Contents/MacOS/ACPBridge"
cp "$ROOT/dist/sidecars/"* "$APP/Contents/MacOS/"
cp -R "$ROOT/public/"* "$APP/Contents/Resources/public/"
cp "$ROOT/acp-bridge.config.json" "$APP/Contents/Resources/acp-bridge.config.default.json"
# Info.plist minimal
# CFBundleExecutable=ACPBridge; LSUIElement optional later
echo "Built $APP"
```

Generate a minimal `Info.plist` with `CFBundleIdentifier` = `apps.9191.ACPBridge`, `CFBundleName` = `ACP Bridge`, `CFBundleExecutable` = `ACPBridge`.

- [ ] **Step 2: Run script; verify tree**

Run: `bash scripts/build-app.sh`

Expected: `dist/ACP Bridge.app/Contents/MacOS/{ACPBridge,acp-bridge,acp-serve,…}` and `Resources/public/index.html`

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore: add build-app.sh to assemble ACP Bridge.app skeleton

EOF
)"
```

---

### Task 7 (M1): SwiftUI shell — serve lifecycle + WebView + Copy paths

**Files:**
- Create: `macos/ACPBridge/ACPBridge.xcodeproj` (or Package.swift + Xcodeproj)
- Create: `macos/ACPBridge/ACPBridge/AppMain.swift`
- Create: `macos/ACPBridge/ACPBridge/ServeProcessManager.swift`
- Create: `macos/ACPBridge/ACPBridge/ApiClient.swift`
- Create: `macos/ACPBridge/ACPBridge/ObservatoryWebView.swift`
- Create: `macos/ACPBridge/ACPBridge/ContentView.swift`
- Create: `macos/ACPBridge/ACPBridgeTests/ServeProcessManagerTests.swift` (port occupied / health parse with URLProtocol mock if feasible)

**Interfaces:**
- `ServeProcessManager`:
  - `func ensureRunning() async throws`
  - `func shutdown()`
  - Uses bundled `acp-serve` next to `Bundle.main.executableURL`
  - Sets env: `ACP_BRIDGE_HOME`, `ACP_BRIDGE_CONFIG`, `ACP_BRIDGE_RESOURCES`
  - On first run: if config missing, copy `acp-bridge.config.default.json` from Resources
- `ApiClient`:
  - `func health() async throws -> Health`
  - Health requires `product == "xcode-acp-bridge"`
- `ContentView`: `WKWebView` → `http://127.0.0.1:8787/` after health OK
- Menu/command: Copy Xcode Executable path = `Bundle.main.bundleURL/Contents/MacOS/acp-bridge`

- [ ] **Step 1: Create macOS App target (SwiftUI, non-sandboxed)**

Disable App Sandbox capability. Deployment macOS 14+.

- [ ] **Step 2: Implement `ServeProcessManager` + unit test for “foreign port” detection**

Logic:

1. GET `http://127.0.0.1:8787/health`
2. If connection fail → spawn `acp-serve`
3. If JSON `product == "xcode-acp-bridge"` → reuse
4. Else → throw `ServeError.portOccupiedByOther`

- [ ] **Step 3: Wire App launch → ensureRunning → show WebView**

Scenes: `WindowGroup` (Dock) + later MenuBarExtra in Task 8.

- [ ] **Step 4: “Copy Xcode Agent paths” button/menu**

Pasteboard string:

```text
Executable: /path/to/ACP Bridge.app/Contents/MacOS/acp-bridge
Interpreter: (leave empty)
```

- [ ] **Step 5: Manual smoke**

Build with Xcode; run App; confirm serve starts; WebView loads Observatory; `curl /health` shows product.

- [ ] **Step 6: Update `build-app.sh` to copy built `ACPBridge` from Xcode `DerivedData` or `xcodebuild` output into `.app` (document exact `xcodebuild` invocation in script comments)

Example:

```bash
xcodebuild -project macos/ACPBridge/ACPBridge.xcodeproj -scheme ACPBridge -configuration Release build
# copy Products/ACPBridge into Contents/MacOS/
```

- [ ] **Step 7: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(macos): M1 shell starts acp-serve and hosts Observatory WebView

EOF
)"
```

---

### Task 8 (M1): MenuBarExtra — Next conversation route + model

**Files:**
- Modify: `macos/ACPBridge/ACPBridge/AppMain.swift`
- Create: `macos/ACPBridge/ACPBridge/MenuBarView.swift`
- Create: `macos/ACPBridge/ACPBridge/RouteMenuModel.swift`
- Create: `macos/ACPBridge/ACPBridgeTests/RouteMenuModelTests.swift`

**Interfaces:**
- `RouteMenuModel`:
  - `func refresh() async`
  - `func setRoute(_ name: String) async throws`
  - `func setModel(_ id: String?) async throws`
  - Uses `GET/PUT /api/acp-route` and `GET /api/acp-models?route=`
- Menu structure matches spec M1 subset (no Recent sessions yet)

- [ ] **Step 1: XCTest with fixture JSON → model publishes routes/models**

- [ ] **Step 2: Implement MenuBarExtra + PUT on selection**

Disable mutating items when `ServeProcessManager` unhealthy.

- [ ] **Step 3: Manual: change Next route in menu → New Conversation in Xcode uses packaged `acp-bridge` + new route**

Prerequisite: user registers Executable to packaged `acp-bridge`.

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(macos): M1 menu switches next ACP route and model

EOF
)"
```

---

### Task 9 (M2): Backend status + Settings + Quit policy

**Files:**
- Create: `macos/ACPBridge/ACPBridge/SettingsView.swift`
- Create: `macos/ACPBridge/ACPBridge/AppSettings.swift` (`@AppStorage`)
- Modify: `MenuBarView.swift` — Backend status submenu from `GET /api/app/status`
- Modify: `ServeProcessManager` / App delegate — quit terminates serve unless `leaveServerRunning`

**Settings keys:**

| Key | Default | Effect |
|-----|---------|--------|
| `showMenuBarExtra` | true | Insert/remove MenuBarExtra |
| `showDockIcon` | true | `NSApp.setActivationPolicy(.regular/.accessory)` |
| `leaveServerRunningOnQuit` | false | Skip terminate `acp-serve` |
| `openAtLogin` | false | `SMAppService.mainApp` register/unregister |

- [ ] **Step 1: Implement Settings scene + persistence**

- [ ] **Step 2: Backend status menu (read-only)**

Show per-route executable + auth detail strings from `/api/app/status`.

- [ ] **Step 3: Quit hook respects `leaveServerRunningOnQuit`

- [ ] **Step 4: Manual smoke Settings toggles**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(macos): M2 settings, backend status, and quit policy

EOF
)"
```

---

### Task 10 (M3): Recent sessions menu actions

**Files:**
- Create: `macos/ACPBridge/ACPBridge/SessionsMenuModel.swift`
- Modify: `MenuBarView.swift`
- Modify: `ObservatoryWebView.swift` / `ContentView` — navigate to `/conversation.html?pid=N` (already supported by `detail.js`)
- Create: tests for SessionsMenuModel parsing

**Interfaces:**
- `GET /api/acp-conversation-sessions` → take first 8 parents; for each use `representativeBridgePid`
- Actions:
  - Set model → `PUT /api/acp-conversations/:pid/model` with `{ model }`
  - Resume → `POST .../resume`
  - Open in Observatory → activate Dock window; `webView.load(URL)` to conversation detail

- [ ] **Step 1: XCTest parse fixture sessions JSON**

- [ ] **Step 2: Implement submenu**

Disable Set model / Resume when API would 409 (no session id) — use fields from summary if present.

- [ ] **Step 3: Manual M3 checklist from spec**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(macos): M3 recent session model switch, resume, and deep link

EOF
)"
```

---

### Task 11: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/acp-bridge.md`
- Optionally: `docs/macos-app.md` short install guide linked from README

**Content to add:**

1. Download/build App via `scripts/build-app.sh` + Xcode
2. First launch copies config to Application Support
3. Xcode Agent table with packaged `acp-bridge` path
4. Menu overview (M1–M3)
5. Note: backends still installed separately; non-sandboxed
6. Developer path still `bun run start`

- [ ] **Step 1: Write docs**

- [ ] **Step 2: Mark design open questions resolved in spec appendix if decisions made during build (single vs dual binary: **dual sidecars** as implemented)

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs: document macOS App shell install and Xcode registration

EOF
)"
```

---

## Spec coverage checklist

| Spec item | Task |
|-----------|------|
| Path discovery env → app → repo | 1 |
| Application Support writable home | 1, 7 |
| Product health fingerprint | 2 |
| `/api/app/status` | 2 |
| Static from Resources | 3 |
| Packaged resume helpers | 4, 5 |
| Compile sidecars | 5 |
| `.app` layout | 6 |
| Serve lifecycle + WebView + Copy paths | 7 |
| Next route/model menu | 8 |
| Backend status + Settings + Quit | 9 |
| Recent sessions actions | 10 |
| Docs | 11 |
| Non-sandbox / no Xcode auto-register / no bundled agents | Constraints + 7 |
| CLI preserved | Constraints + 1 (`repo` mode) |

## Plan self-review notes

- Fixed Xcode-env gap already in spec; Task 1 encodes discovery order.
- Chose **two sidecars** (`acp-bridge` + `acp-serve`) plus resume binaries (open question #1).
- Deep link uses existing `/conversation.html?pid=` (no new query inventiveness required).
- Swift project is created in Task 7; Task 6 may ship placeholder `ACPBridge` until then.
