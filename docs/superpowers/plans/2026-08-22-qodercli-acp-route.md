# Qoder CLI ACP Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `qodercli` ACP route (`qodercli --acp`) with models, spawn-arg `--model`, Terminal resume via ACP `session/load`, and a defensive `qoder/*` extension shim — without changing `defaultRoute` or Cursor behavior.

**Architecture:** Parallel to Cursor: config route + shared `spawn-arg` helper; dedicated `resumeMode: "qoder-acp-load"` and `qoder-acp-resume.ts` (do not modify Cursor helper); `qoder-shim.ts` mirrors cursor-shim wiring in `run-bridge.ts`.

**Tech Stack:** Bun, TypeScript, existing Hono dashboard, bun:test.

**Spec:** [2026-08-22-qodercli-acp-route-design.md](../specs/2026-08-22-qodercli-acp-route-design.md)

## Global Constraints

- `defaultRoute` stays `"opencode"`
- Do not change Cursor `cursor-acp-load` / `cursor-acp-resume.ts` behavior
- ACP entry is `qodercli --acp` (flag), not subcommand `acp`
- Terminal resume uses ACP `session/load` + auth `qodercli-login`, not CLI `-r`
- Model spawn flag is existing `--model` via `resolveBackendSpawnArgs`
- Work on current branch; commit after each task

## File map

| File | Responsibility |
|------|----------------|
| `src/acp/types.ts` | Add `"qoder-acp-load"` to `AcpResumeMode` |
| `src/acp/config.ts` | Accept new `resumeMode` in `isBackend` |
| `src/acp/models.ts` | Skip `MODEL` header in `parseModelsOutput` |
| `acp-bridge.config.json` | Add `qodercli` route |
| `src/acp/qoder-acp-resume.ts` | Terminal ACP load client |
| `src/dashboard/acp-routes.ts` | `qoderAcpResumeScriptPath` + `buildResumeLaunchArgs` branch |
| `src/setup-check.ts` / `scripts/setup.ts` | Detect `qodercli`; auth hint |
| `src/acp/qoder-shim.ts` | Intercept `qoder/*`; ack blocking requests |
| `src/acp/run-bridge.ts` | Call qoder shim beside cursor shim |
| `tests/*` | Unit/integration coverage |
| `README.md`, `docs/acp-bridge.md`, `docs/acp-backend-integration.md` | Document route |

---

### Task 1: Types, config validation, models header, route config

**Files:**
- Modify: `src/acp/types.ts`
- Modify: `src/acp/config.ts`
- Modify: `src/acp/models.ts`
- Modify: `acp-bridge.config.json`
- Modify: `tests/acp-config.test.ts`
- Modify: `tests/acp-models.test.ts`

**Interfaces:**
- Consumes: existing `AcpResumeMode`, `parseModelsOutput`, `loadAcpBridgeConfig`
- Produces: `AcpResumeMode` includes `"qoder-acp-load"`; config accepts it; `parseModelsOutput` drops `MODEL`

- [ ] **Step 1: Write failing tests**

Append to `tests/acp-config.test.ts`:

```typescript
  test("loads resumeMode qoder-acp-load", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        routes: {
          qodercli: {
            command: "/bin/echo",
            args: ["--acp"],
            modelApply: "spawn-arg",
            resumeMode: "qoder-acp-load",
          },
        },
        defaultRoute: "qodercli",
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.routes.qodercli.resumeMode).toBe("qoder-acp-load");
    expect(cfg.routes.qodercli.modelApply).toBe("spawn-arg");
  });

  test("throws naming the route key when resumeMode is invalid", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {
            qodercli: { command: "/bin/echo", args: ["--acp"], resumeMode: "cli-r" },
          },
          defaultRoute: "qodercli",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 99,
        }),
      ),
    ).toThrow(/routes\.qodercli/);
  });
```

Append to `tests/acp-models.test.ts` inside `describe("parseModelsOutput")`:

```typescript
  test("skips Qoder MODEL header and keeps ids", () => {
    expect(parseModelsOutput("MODEL\nQwen3.8-Max\n")).toEqual(["Qwen3.8-Max"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/acp-config.test.ts tests/acp-models.test.ts`

Expected: FAIL — `qoder-acp-load` rejected by `isBackend` and/or `MODEL` still in parsed ids.

- [ ] **Step 3: Implement**

In `src/acp/types.ts`, change:

```typescript
export type AcpResumeMode = "args" | "cursor-acp-load" | "qoder-acp-load";
```

Update the JSDoc on `resumeMode` to mention both ACP-load helpers.

In `src/acp/config.ts` `isBackend`:

```typescript
  if (
    resumeMode !== undefined &&
    resumeMode !== "args" &&
    resumeMode !== "cursor-acp-load" &&
    resumeMode !== "qoder-acp-load"
  )
    return false;
```

In `src/acp/models.ts` `parseModelsOutput`, after the Available models skip:

```typescript
    if (/^available models$/i.test(line)) continue;
    if (/^model$/i.test(line)) continue;
```

In `acp-bridge.config.json`, add alongside existing routes (keep `"defaultRoute": "opencode"`):

```json
    "qodercli": {
      "command": "~/.local/bin/qodercli",
      "args": ["--acp"],
      "modelApply": "spawn-arg",
      "resumeMode": "qoder-acp-load",
      "modelsCommand": {
        "command": "~/.local/bin/qodercli",
        "args": ["--list-models"]
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/acp-config.test.ts tests/acp-models.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/acp/types.ts src/acp/config.ts src/acp/models.ts acp-bridge.config.json \
  tests/acp-config.test.ts tests/acp-models.test.ts
git commit -m "$(cat <<'EOF'
feat(acp): add qodercli route config and MODEL header parse

EOF
)"
```

---

### Task 2: Terminal resume helper + dashboard launch

**Files:**
- Create: `src/acp/qoder-acp-resume.ts`
- Modify: `src/dashboard/acp-routes.ts`
- Modify: `tests/acp-spawn-args.test.ts`
- Modify: `tests/acp-dashboard.test.ts` (only if resume PUT assertions need a qoder fixture; prefer spawn-args unit test first)

**Interfaces:**
- Consumes: `AcpResumeMode` including `"qoder-acp-load"`
- Produces: `qoderAcpResumeScriptPath(): string`; `buildResumeLaunchArgs` returns bun + helper argv for qoder mode; helper CLI: `--agent`, `--session-id`, optional `--cwd`

- [ ] **Step 1: Write failing test**

In `tests/acp-spawn-args.test.ts`, import `qoderAcpResumeScriptPath` (will not exist yet) and add:

```typescript
  test("qoder-acp-load mode launches bun qoder helper with agent + session", () => {
    const launched = buildResumeLaunchArgs(
      {
        command: "/Users/me/.local/bin/qodercli",
        resumeMode: "qoder-acp-load",
      },
      "sess-qoder-1",
      "/Users/me/proj",
    );
    expect(launched.bin).toBe(process.execPath);
    expect(launched.argv).toEqual([
      qoderAcpResumeScriptPath(),
      "--agent",
      "/Users/me/.local/bin/qodercli",
      "--session-id",
      "sess-qoder-1",
      "--cwd",
      "/Users/me/proj",
    ]);
    expect(launched.argv[0]).toBe(path.join(repoRoot(), "src", "acp", "qoder-acp-resume.ts"));
  });
```

Update import from `../src/dashboard/acp-routes` to include `qoderAcpResumeScriptPath`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/acp-spawn-args.test.ts`

Expected: FAIL — missing export / mode falls through to args.

- [ ] **Step 3: Implement helper + launch branch**

Create `src/acp/qoder-acp-resume.ts` by copying `src/acp/cursor-acp-resume.ts` and changing:

1. File header comment: Qoder ACP sessions; spawn `[agent, "--acp"]` (not `["acp"]`).
2. Spawn:

```typescript
const proc = spawn([agent, "--acp"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
  cwd,
});
```

3. Authenticate:

```typescript
  await send("authenticate", { methodId: "qodercli-login" });
```

4. Keep `session/load`, permission allow-once, and interactive prompt loop identical in structure to Cursor helper.

In `src/dashboard/acp-routes.ts`:

```typescript
export function qoderAcpResumeScriptPath(): string {
  return path.join(repoRoot(), "src", "acp", "qoder-acp-resume.ts");
}
```

In `buildResumeLaunchArgs`, after the `cursor-acp-load` block:

```typescript
  if (mode === "qoder-acp-load") {
    const argv = [
      qoderAcpResumeScriptPath(),
      "--agent",
      backend.command,
      "--session-id",
      sessionId,
    ];
    if (cwd) argv.push("--cwd", cwd);
    return { bin: process.execPath, argv };
  }
```

In `openTerminalResume`, treat `qoder-acp-load` like cursor for the `cd` skip (helper passes `--cwd`):

```typescript
  const cd =
    (resumeMode === "args" || resumeMode == null) && cwd
      ? `cd ${shellQuote(cwd)} || exit 1\n`
      : "";
```

(Or explicitly: skip cd when mode is `cursor-acp-load` or `qoder-acp-load`.)

- [ ] **Step 4: Run tests**

Run: `bun test tests/acp-spawn-args.test.ts tests/acp-dashboard.test.ts`

Expected: PASS (dashboard cursor resume tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/acp/qoder-acp-resume.ts src/dashboard/acp-routes.ts tests/acp-spawn-args.test.ts
git commit -m "$(cat <<'EOF'
feat(acp): add qoder-acp-load Terminal session/load resume

EOF
)"
```

---

### Task 3: Setup detection for qodercli

**Files:**
- Modify: `src/setup-check.ts`
- Modify: `scripts/setup.ts`
- Create or modify: `tests/setup-check.test.ts` (if one exists; else add focused tests next to existing setup tests)

**Interfaces:**
- Consumes: `which`, `hasExecutable`, `os.homedir`
- Produces: `detectQodercli(): string | null`; `detectBackendBinary` returns qoder for qodercli routes; setup warns about login / `QODER_PERSONAL_ACCESS_TOKEN`

- [ ] **Step 1: Find existing setup tests**

Run: `ls tests | rg setup; rg -n "detectAgent|detectOpencode" tests src`

If no unit test file, add `tests/setup-check.test.ts` with path-based tests using temp dirs only if cheap; otherwise smoke via exporting `detectQodercli` and asserting it returns null when binary absent (mock-free: call with overridden candidates is hard — prefer testing `detectBackendBinary("qodercli", "/nonexistent/qodercli")` still tries detect path). Minimal acceptable test:

```typescript
import { describe, expect, test } from "bun:test";
import { detectBackendBinary } from "../src/setup-check";

describe("detectBackendBinary", () => {
  test("qodercli route prefers qoder detection over opencode", () => {
    // basename qodercli → detectQodercli path; may be null on CI without install — assert function runs and does not throw
    expect(() => detectBackendBinary("qodercli", "/tmp/qodercli")).not.toThrow();
  });
});
```

Prefer a stronger test if the codebase already patterns mockable detectors; match local style.

- [ ] **Step 2: Implement detection**

In `src/setup-check.ts`:

```typescript
export function detectQodercli(): string | null {
  const candidates = [
    ...(which("qodercli") ? [which("qodercli")!] : []),
    path.join(os.homedir(), ".local", "bin", "qodercli"),
  ].filter((p, i, a) => p && a.indexOf(p) === i && hasExecutable(p));
  return candidates.length > 0 ? candidates[0] : null;
}
```

Update `detectBackendBinary`:

```typescript
export function detectBackendBinary(routeName: string, command: string): string | null {
  const base = path.basename(command);
  if (routeName === "cursor" || base === "agent" || base === "cursor-agent") {
    return detectAgent();
  }
  if (routeName === "qodercli" || base === "qodercli" || base === "qoder") {
    return detectQodercli();
  }
  return detectOpencode();
}
```

Optional light auth hint (no JSON required): if `qodercli` route present and executable, run `qodercli status` with timeout; if exit non-zero or stdout empty, `warn` to run `qodercli login` or set `QODER_PERSONAL_ACCESS_TOKEN`. If status shows `Username:`, treat as ok. Keep Cursor auth block unchanged.

In `scripts/setup.ts`, extend the “no binary” failure message to mention Qoder CLI, and add a qoder routes block similar to `agentRoutes`:

```typescript
const qoderRoutes = Object.entries(cfg.routes).filter(
  ([name, b]) => name === "qodercli" || ["qodercli", "qoder"].includes(path.basename(b.command)),
);
```

Warn if missing; if present, print auth hint as above. Update `stillMissing` fail path to mention `detectQodercli()` as well.

- [ ] **Step 3: Run tests**

Run: `bun test tests/setup-check.test.ts` (or whatever file was added) and `bun test`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/setup-check.ts scripts/setup.ts tests/setup-check.test.ts
git commit -m "$(cat <<'EOF'
feat(setup): detect qodercli and hint login

EOF
)"
```

---

### Task 4: Qoder extension shim + bridge wire

**Files:**
- Create: `src/acp/qoder-shim.ts`
- Create: `tests/acp-qoder-shim.test.ts`
- Modify: `src/acp/run-bridge.ts`
- Optional: `tests/acp-bridge.test.ts` (one integration line if cheap)

**Interfaces:**
- Consumes: a2c line string, `lastSessionId: string | null`
- Produces: `handleQoderExtensionLine(line, sessionId): CursorShimAction-shaped | null` — reuse same action type shape:

```typescript
export type QoderShimAction = {
  suppressOriginal: boolean;
  agentReplies: string[];
  clientNotifications: string[];
};
```

v1 behavior (defensive; refine after real capture):

| Method | Behavior |
|--------|----------|
| any `qoder/*` with `id` | Ack `{ outcome: { outcome: "accepted" } }` (or empty `result: {}` if unknown shape); suppress forward |
| `qoder/*` notification (no id) | Suppress; do not forward |
| non-`qoder/*` | return null |

Do **not** invent create_plan formatting unless a real method is observed during this task. If a quick probe with `qodercli --acp` + a short prompt is possible in the implementer’s environment, capture methods and tighten; otherwise ship the generic ack table above and document “expand after capture” in the commit message.

- [ ] **Step 1: Write failing unit tests**

`tests/acp-qoder-shim.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { handleQoderExtensionLine, parseQoderExtensionLine } from "../src/acp/qoder-shim";

describe("parseQoderExtensionLine", () => {
  test("detects qoder/* methods", () => {
    const msg = parseQoderExtensionLine(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "qoder/example", params: {} }),
    );
    expect(msg?.method).toBe("qoder/example");
  });

  test("ignores standard ACP methods", () => {
    expect(
      parseQoderExtensionLine(
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} }),
      ),
    ).toBeNull();
  });
});

describe("handleQoderExtensionLine", () => {
  test("acks blocking qoder/* and suppresses", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "qoder/example",
      params: {},
    });
    const action = handleQoderExtensionLine(line, "sess-1");
    expect(action).not.toBeNull();
    expect(action!.suppressOriginal).toBe(true);
    expect(action!.clientNotifications).toEqual([]);
    expect(JSON.parse(action!.agentReplies[0]!)).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: { outcome: { outcome: "accepted" } },
    });
  });

  test("suppresses notification-shaped qoder/* without reply", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "qoder/example",
      params: {},
    });
    const action = handleQoderExtensionLine(line, null);
    expect(action!.suppressOriginal).toBe(true);
    expect(action!.agentReplies).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `bun test tests/acp-qoder-shim.test.ts`

- [ ] **Step 3: Implement shim + wire run-bridge**

Implement `src/acp/qoder-shim.ts` following the structure of `cursor-shim.ts` but only for `method.startsWith("qoder/")` and the generic ack rules above.

In `src/acp/run-bridge.ts`, import `handleQoderExtensionLine` and after the cursor shim block (or before, order does not matter if prefixes differ):

```typescript
    const qoderShim = handleQoderExtensionLine(line, lastSessionId);
    if (qoderShim) {
      for (const note of qoderShim.clientNotifications) {
        await logRpc("a2c", note);
        opts.stdout.write(`${note}\n`);
      }
      for (const reply of qoderShim.agentReplies) {
        await logRpc("c2a", reply);
        try {
          proc.stdin.write(`${reply}\n`);
        } catch {
          // backend stdin already closed
        }
      }
      if (qoderShim.suppressOriginal) return;
    }
```

- [ ] **Step 4: Run full test suite**

Run: `bun test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/acp/qoder-shim.ts tests/acp-qoder-shim.test.ts src/acp/run-bridge.ts
git commit -m "$(cat <<'EOF'
feat(acp): add qoder extension shim to prevent prompt hangs

EOF
)"
```

---

### Task 5: Docs + integration checklist

**Files:**
- Modify: `README.md`
- Modify: `docs/acp-bridge.md`
- Modify: `docs/acp-backend-integration.md`

**Interfaces:** none (documentation only)

- [ ] **Step 1: Update docs**

`README.md` — add `qodercli` example under routes config (mirror cursor block); mention `--acp`, `modelApply: spawn-arg`, `resumeMode: qoder-acp-load`, shim one-liner.

`docs/acp-bridge.md` — config table: document `qoder-acp-load`; note shim file; list grouping unchanged.

`docs/acp-backend-integration.md` §10 — extend comparison table:

| | OpenCode | Cursor CLI | Qoder CLI |
|---|---|---|---|
| 入口 | `opencode acp` | `agent acp` | `qodercli --acp` |
| 模型应用 | inject | spawn-arg `--model` | spawn-arg `--model` |
| Terminal resume | `-s {sessionId}` | `cursor-acp-load` | `qoder-acp-load` (`session/load` + `qodercli-login`) |
| 扩展 RPC | 少 | `cursor/*` shim | `qoder/*` shim（通用 ack；按抓包加深） |
| 默认 route | 是 | 否 | 否 |

Manual checklist quick smoke: add selecting `qodercli` after restart.

- [ ] **Step 2: Commit**

```bash
git add README.md docs/acp-bridge.md docs/acp-backend-integration.md
git commit -m "$(cat <<'EOF'
docs: document qodercli ACP route and checklist row

EOF
)"
```

- [ ] **Step 3: Manual smoke (implementer)**

1. `bun run start` (restart dashboard); hard-refresh Observatory  
2. Select Next conversation route `qodercli`  
3. Xcode New Conversation → one prompt → expect `stopReason` / no forever spinner  
4. Confirm models dropdown; optional model then new spawn shows `--model` in `process_start`  
5. Observatory resume on a session with `acpSessionId` → Terminal helper loads  

Record any new vendor methods found for a follow-up shim commit (out of plan scope if already shipping generic ack).

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Route config + spawn-arg + modelsCommand | Task 1 |
| Skip MODEL header | Task 1 |
| defaultRoute stays opencode | Task 1 (config) |
| `qoder-acp-load` + `qoder-acp-resume.ts` + `session/load` + `qodercli-login` | Task 2 |
| Setup detect + auth hint | Task 3 |
| Extension shim + run-bridge | Task 4 |
| Docs / checklist | Task 5 |
| Do not change Cursor paths | Explicit in Global Constraints + Task 2 |

No TBD placeholders. Types consistent: `qoder-acp-load`, `qoderAcpResumeScriptPath`, `handleQoderExtensionLine`.
