# ACP Observe and Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the ACP product: spawn-time route selection among configured ACP executables, plus a conversation-first dashboard (identities, collapsed chunks, next-conversation route picker).

**Architecture:** Keep the existing stdio tee. Config gains a `routes` map. `data/acp-route.json` is the next-spawn choice (dashboard writes, bridge reads once at start). Conversations are a pure aggregation of `AcpEvent[]` keyed by `bridgePid`. Bytes on the wire stay unchanged.

**Tech Stack:** Bun, TypeScript, Hono, `bun:test`, existing `public/` HTML/JS.

## Global Constraints

- Do not rewrite JSON-RPC. Do not bind HTTP inside `acp-bridge`.
- Route is chosen at **process start**. Never from `session/new`, `ses_…`, or `MCP_XCODE_SESSION_ID`.
- Mid-session executable switch is forbidden.
- `command` paths are absolute. Resolve file paths against **repo root**, not `process.cwd()`.
- Config: `ACP_BRIDGE_CONFIG` or `<repoRoot>/acp-bridge.config.json`.
- Route state file: `routeStatePath` (default `./data/acp-route.json`), gitignored via `data/`.
- JSONL remains append-only; do not rewrite earlier lines. Aggregator must work on old events by parsing `raw`.
- New `AcpEvent` fields are optional (`?:`) so existing fixtures/helpers typecheck.
- Xcode Interpreter: `~/.bun/bin/bun`. Executable: `/path/to/xcode-acp-bridge/src/acp-bridge.ts`. Arguments empty.
- One Xcode spawn → one backend process. Stdin EOF: end backend stdin, drain ≤2s, kill, exit 0.
- HTTP observer on `127.0.0.1:8787` stays unchanged.
- Do not add a `pi-xcode` path to the committed default config; only document how to add a route.
- Keep synthesizing `defaultBackend` as `routes[defaultRoute]` so existing `defaultBackend`-only test configs still load.

**Spec:** `docs/superpowers/specs/2026-08-15-acp-observe-and-route-design.md`

---

## File map

| Path | Responsibility |
|---|---|
| `src/acp/types.ts` | `AcpBackend`, extended `AcpBridgeConfig` + optional event fields |
| `src/acp/config.ts` | load `routes` / `defaultRoute` / `routeStatePath`; `defaultBackend` compat |
| `src/acp/route-state.ts` | read/write `data/acp-route.json`; `resolveRoute` |
| `src/acp/parse.ts` | `cwd`, `MCP_XCODE_SESSION_ID`, `sessionUpdate`, `toolName`; hints include MCP id |
| `src/acp/conversations.ts` | `summarizeConversations`, `conversationDetail`, timeline collapse |
| `src/acp/run-bridge.ts` | copy parse meta onto events; `process_start.route` |
| `src/acp-bridge.ts` | resolve route at startup, stderr fallback, spawn that backend |
| `acp-bridge.config.json` | committed `routes` + `defaultRoute` + `routeStatePath` |
| `src/dashboard/acp-routes.ts` | GET/PUT `/api/acp-route`, GET conversations |
| `src/index.ts` | pass config into ACP dashboard app |
| `public/index.html`, `public/app.js`, `public/styles.css` | conversation list, timeline, next-route select |
| `tests/acp-config.test.ts` | routes + compat + validation |
| `tests/acp-route-state.test.ts` | file + resolve |
| `tests/acp-parse.test.ts` | identity fields |
| `tests/acp-conversations.test.ts` | summaries + timeline |
| `tests/acp-bridge.test.ts` | spawn uses resolved route |
| `tests/acp-dashboard.test.ts` | new APIs |
| `README.md` | conversation UI + adding routes |

---

### Task 1: Config — routes, defaultRoute, routeStatePath

**Files:**
- Modify: `src/acp/types.ts`
- Modify: `src/acp/config.ts`
- Modify: `acp-bridge.config.json`
- Modify: `tests/acp-config.test.ts`

**Interfaces:**
- Consumes: existing `loadAcpBridgeConfig`, `repoRoot`
- Produces:

```typescript
export type AcpBackend = { command: string; args: string[] };

export type AcpEvent = {
  // existing required fields unchanged
  route?: string | null;
  cwd?: string | null;
  mcpXcodeSessionId?: string | null;
  sessionUpdate?: string | null;
  toolName?: string | null;
};

export type AcpBridgeConfig = {
  routes: Record<string, AcpBackend>;
  defaultRoute: string;
  defaultBackend: AcpBackend;
  eventsPath: string;
  routeStatePath: string;
  maxRawBytes: number;
};
```

- [ ] **Step 1: Write failing config tests**

Replace `tests/acp-config.test.ts` with:

```typescript
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAcpBridgeConfig, repoRoot } from "../src/acp/config";

function writeCfg(body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-cfg-"));
  const cfgPath = path.join(dir, "cfg.json");
  fs.writeFileSync(cfgPath, JSON.stringify(body));
  return cfgPath;
}

describe("loadAcpBridgeConfig", () => {
  test("loads routes and resolves paths against repo root", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        routes: { opencode: { command: "/bin/echo", args: ["acp"] } },
        defaultRoute: "opencode",
        eventsPath: "./data/acp-events.jsonl",
        routeStatePath: "./data/acp-route.json",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.defaultRoute).toBe("opencode");
    expect(cfg.routes.opencode.command).toBe("/bin/echo");
    expect(cfg.defaultBackend).toEqual({ command: "/bin/echo", args: ["acp"] });
    expect(cfg.eventsPath).toBe(path.join(repoRoot(), "data/acp-events.jsonl"));
    expect(cfg.routeStatePath).toBe(path.join(repoRoot(), "data/acp-route.json"));
    expect(cfg.maxRawBytes).toBe(99);
  });

  test("defaultBackend-only config becomes routes.default", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        defaultBackend: { command: "/bin/echo", args: ["acp"] },
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.defaultRoute).toBe("default");
    expect(cfg.routes.default.command).toBe("/bin/echo");
    expect(cfg.defaultBackend.command).toBe("/bin/echo");
    expect(cfg.routeStatePath).toBe(path.join(repoRoot(), "data/acp-route.json"));
  });

  test("throws when routes empty and no defaultBackend", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {},
          defaultRoute: "x",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 1,
        }),
      ),
    ).toThrow(/routes/i);
  });

  test("throws when defaultRoute is not a route key", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: { opencode: { command: "/bin/echo", args: ["acp"] } },
          defaultRoute: "missing",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 1,
        }),
      ),
    ).toThrow(/defaultRoute/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/acp-config.test.ts`

Expected: FAIL (missing `routes` / `routeStatePath` on the returned config).

- [ ] **Step 3: Implement types + loader**

`src/acp/types.ts` — add `AcpBackend`; extend `AcpEvent` with the five optional fields; replace `AcpBridgeConfig` with the shape in Interfaces.

`src/acp/config.ts` — after `JSON.parse`:

1. Let `routes` = `parsed.routes` if it is a non-empty object.
2. Else if `parsed.defaultBackend` has `command` + `args`, set `routes = { default: parsed.defaultBackend }` and `defaultRoute = parsed.defaultRoute ?? "default"`.
3. Else throw `Error("acp-bridge config: routes is empty")`.
4. `defaultRoute` = `parsed.defaultRoute` if using explicit routes; must be a key of `routes` or throw `Error("acp-bridge config: defaultRoute … not in routes")`.
5. `routeStatePath` = `parsed.routeStatePath ?? "./data/acp-route.json"`; resolve like `eventsPath` (absolute keep, else `path.join(repoRoot(), …)`).
6. `defaultBackend` = `routes[defaultRoute]`.
7. Return `{ routes, defaultRoute, defaultBackend, eventsPath, routeStatePath, maxRawBytes }`.

Replace `acp-bridge.config.json` with:

```json
{
  "routes": {
    "opencode": {
      "command": "~/.opencode/bin/opencode",
      "args": ["acp"]
    }
  },
  "defaultRoute": "opencode",
  "eventsPath": "./data/acp-events.jsonl",
  "routeStatePath": "./data/acp-route.json",
  "maxRawBytes": 2097152
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/acp-config.test.ts`

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/acp/types.ts src/acp/config.ts acp-bridge.config.json tests/acp-config.test.ts
git commit -m "$(cat <<'EOF'
feat: load named ACP routes from bridge config

EOF
)"
```

---

### Task 2: Route state file and resolveRoute

**Files:**
- Create: `src/acp/route-state.ts`
- Create: `tests/acp-route-state.test.ts`

**Interfaces:**
- Consumes: `AcpBridgeConfig` from Task 1
- Produces:

```typescript
export type AcpRouteState = { route: string };

export function loadAcpRouteState(filePath: string): AcpRouteState | null;
export function writeAcpRouteState(filePath: string, state: AcpRouteState): void;
export function resolveRoute(
  config: AcpBridgeConfig,
  state: AcpRouteState | null,
): { name: string; backend: AcpBackend; fallbackReason: "missing" | "unknown_route" | null };
```

- [ ] **Step 1: Write failing tests**

Create `tests/acp-route-state.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AcpBridgeConfig } from "../src/acp/types";
import { loadAcpRouteState, resolveRoute, writeAcpRouteState } from "../src/acp/route-state";

const dir = path.join(import.meta.dir, ".tmp-acp-route");
const filePath = path.join(dir, "acp-route.json");

const config: AcpBridgeConfig = {
  routes: {
    opencode: { command: "/bin/echo", args: ["acp"] },
    other: { command: "/bin/true", args: [] },
  },
  defaultRoute: "opencode",
  defaultBackend: { command: "/bin/echo", args: ["acp"] },
  eventsPath: "/tmp/e.jsonl",
  routeStatePath: filePath,
  maxRawBytes: 1,
};

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadAcpRouteState", () => {
  test("missing file returns null", () => {
    expect(loadAcpRouteState(filePath)).toBeNull();
  });

  test("valid file returns route", () => {
    fs.writeFileSync(filePath, JSON.stringify({ route: "other" }));
    expect(loadAcpRouteState(filePath)).toEqual({ route: "other" });
  });

  test("invalid json returns null", () => {
    fs.writeFileSync(filePath, "{nope");
    expect(loadAcpRouteState(filePath)).toBeNull();
  });

  test("missing route string returns null", () => {
    fs.writeFileSync(filePath, JSON.stringify({}));
    expect(loadAcpRouteState(filePath)).toBeNull();
  });
});

describe("writeAcpRouteState", () => {
  test("creates parent dirs and round-trips", () => {
    const nested = path.join(dir, "nested", "acp-route.json");
    writeAcpRouteState(nested, { route: "opencode" });
    expect(loadAcpRouteState(nested)).toEqual({ route: "opencode" });
  });
});

describe("resolveRoute", () => {
  test("state wins when the name exists", () => {
    const r = resolveRoute(config, { route: "other" });
    expect(r.name).toBe("other");
    expect(r.backend.command).toBe("/bin/true");
    expect(r.fallbackReason).toBeNull();
  });

  test("missing state uses defaultRoute", () => {
    const r = resolveRoute(config, null);
    expect(r.name).toBe("opencode");
    expect(r.fallbackReason).toBe("missing");
  });

  test("unknown state name uses defaultRoute", () => {
    const r = resolveRoute(config, { route: "nope" });
    expect(r.name).toBe("opencode");
    expect(r.fallbackReason).toBe("unknown_route");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/acp-route-state.test.ts`

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/acp/route-state.ts`**

- `loadAcpRouteState`: if `!fs.existsSync` return null. `JSON.parse` in try/catch; on failure return null. If `typeof parsed.route !== "string"` or empty string, return null. Else `{ route: parsed.route }`.
- `writeAcpRouteState`: `fs.mkdirSync(path.dirname(filePath), { recursive: true })`; write `JSON.stringify(state) + "\n"` with utf8.
- `resolveRoute`: if `state?.route` is a key of `config.routes`, return that backend and `fallbackReason: null`. If `state` is null, `fallbackReason: "missing"`. Else `fallbackReason: "unknown_route"`. Backend is always `config.routes[name]` where `name` is the chosen key (`state.route` or `config.defaultRoute`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/acp-route-state.test.ts tests/acp-config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/acp/route-state.ts tests/acp-route-state.test.ts
git commit -m "$(cat <<'EOF'
feat: resolve next ACP spawn from route state file

EOF
)"
```

---

### Task 3: Parse cwd, MCP session id, sessionUpdate, toolName

**Files:**
- Modify: `src/acp/parse.ts`
- Modify: `tests/acp-parse.test.ts`

**Interfaces:**
- Consumes: existing `parseRpcLine` / `extractSessionHints`
- Produces: `parseRpcLine` also returns `cwd`, `mcpXcodeSessionId`, `sessionUpdate`, `toolName` (all `string | null`). `extractSessionHints` also collects string values of key `MCP_XCODE_SESSION_ID`. Export `extractRpcMeta(value: unknown)` used by the aggregator for old events:

```typescript
export type RpcMeta = {
  cwd: string | null;
  mcpXcodeSessionId: string | null;
  sessionUpdate: string | null;
  toolName: string | null;
  sessionHints: string[];
};

export function extractRpcMeta(value: unknown): RpcMeta;
```

- [ ] **Step 1: Write failing parse tests**

Append to `tests/acp-parse.test.ts` (keep existing tests):

```typescript
import { extractRpcMeta } from "../src/acp/parse";

const sessionNew = {
  jsonrpc: "2.0",
  id: "uuid-1",
  method: "session/new",
  params: {
    cwd: "/Users/me/App",
    mcpServers: [
      {
        name: "xcode-tools",
        command: "xcrun",
        args: ["mcpbridge"],
        env: {
          MCP_XCODE_SESSION_ID: "68D39EB1-F780-484E-8656-26B8F291C390",
          MCP_XCODE_PID: "1",
        },
      },
    ],
  },
};

describe("extractRpcMeta", () => {
  test("reads cwd and MCP_XCODE_SESSION_ID from session/new", () => {
    const meta = extractRpcMeta(sessionNew);
    expect(meta.cwd).toBe("/Users/me/App");
    expect(meta.mcpXcodeSessionId).toBe("68D39EB1-F780-484E-8656-26B8F291C390");
    expect(meta.sessionHints).toContain("68D39EB1-F780-484E-8656-26B8F291C390");
  });

  test("reads tool_call title as toolName", () => {
    const meta = extractRpcMeta({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses_abc",
        update: { sessionUpdate: "tool_call", title: "XcodeRead", kind: "read" },
      },
    });
    expect(meta.sessionUpdate).toBe("tool_call");
    expect(meta.toolName).toBe("XcodeRead");
    expect(meta.sessionHints).toContain("ses_abc");
  });

  test("toolName falls back to name then kind", () => {
    expect(
      extractRpcMeta({
        method: "session/update",
        params: { update: { sessionUpdate: "tool_call", name: "n", kind: "k" } },
      }).toolName,
    ).toBe("n");
    expect(
      extractRpcMeta({
        method: "session/update",
        params: { update: { sessionUpdate: "tool_call", kind: "k" } },
      }).toolName,
    ).toBe("k");
  });
});

describe("parseRpcLine meta", () => {
  test("copies extractRpcMeta onto parseRpcLine result", () => {
    const parsed = parseRpcLine(JSON.stringify(sessionNew), 10_000);
    expect(parsed.cwd).toBe("/Users/me/App");
    expect(parsed.mcpXcodeSessionId).toBe("68D39EB1-F780-484E-8656-26B8F291C390");
  });
});
```

Update the existing `extractSessionHints` import list to include `extractRpcMeta`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/acp-parse.test.ts`

Expected: FAIL (`extractRpcMeta` not exported / fields missing).

- [ ] **Step 3: Implement**

In `src/acp/parse.ts`:

- In `walk`, if `k === "MCP_XCODE_SESSION_ID"` and `v` is a non-empty string, `out.add(v)` (same set as session hints).
- `extractRpcMeta(value)`:
  - `sessionHints = extractSessionHints(value)`
  - `cwd`: if `value` is an object with `params` object and `params.cwd` is a non-empty string, use it; else null
  - `mcpXcodeSessionId`: first hint that equals a walked `MCP_XCODE_SESSION_ID`, or walk specifically for that key (implement a small walker that records the first `MCP_XCODE_SESSION_ID` string)
  - `sessionUpdate`: `params.update.sessionUpdate` if string, else null
  - `toolName`: only when `sessionUpdate` is `tool_call` or `tool_call_update`: first non-empty string among `update.title`, `update.name`, `update.kind`; else null
- `parseRpcLine`: on successful JSON.parse, spread `extractRpcMeta(parsed)` into the return object. On parse failure, those four fields are null.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/acp-parse.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/acp/parse.ts tests/acp-parse.test.ts
git commit -m "$(cat <<'EOF'
feat: extract ACP cwd, Xcode session id, and tool names

EOF
)"
```

---

### Task 4: Conversation aggregator

**Files:**
- Create: `src/acp/conversations.ts`
- Create: `tests/acp-conversations.test.ts`

**Interfaces:**
- Consumes: `AcpEvent`, `extractRpcMeta`
- Produces:

```typescript
export type ConversationStatus = "live" | "ended" | "error";

export type ConversationSummary = {
  bridgePid: number;
  backendPid: number | null;
  route: string | null;
  cwd: string | null;
  mcpXcodeSessionId: string | null;
  acpSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  status: ConversationStatus;
  promptCount: number;
  toolCallCount: number;
  eventCount: number;
};

export type TimelineItem =
  | { type: "process"; kind: "process_start" | "process_start_error" | "process_end"; ts: string; eventId: string; route: string | null }
  | { type: "rpc"; method: string; dir: "c2a" | "a2c" | null; rpcId: string | number | null; ts: string; eventId: string }
  | { type: "tool_call"; name: string; ts: string; eventId: string; updateCount: number }
  | { type: "chunks"; update: string; count: number; firstTs: string; lastTs: string; eventIds: string[] };

export type ConversationDetail = ConversationSummary & { timeline: TimelineItem[] };

export function hydrateEvent(event: AcpEvent): AcpEvent;
export function summarizeConversations(events: AcpEvent[]): ConversationSummary[];
export function conversationDetail(events: AcpEvent[], bridgePid: number): ConversationDetail | null;
```

Rules (copy into the implementation, do not invent others):

- Group by `bridgePid`. Sort summaries by `startedAt` descending.
- `startedAt` = first event `ts` (prefer `process_start` if present).
- `status`: `error` if any `process_start_error`; else `ended` if any `process_end`; else `live`.
- `endedAt` = `process_end.ts` or `process_start_error.ts` or null.
- `route` = `process_start.route` or `JSON.parse(process_start.raw).route` if string.
- `cwd` / `mcpXcodeSessionId` = first hydrated non-null on that pid.
- `acpSessionId` = first `sessionHints` value that is not `mcpXcodeSessionId`.
- `promptCount` = events with `method === "session/prompt"`.
- `toolCallCount` = hydrated `sessionUpdate === "tool_call"` (not `tool_call_update`).
- Timeline walks events for that pid in chronological order (`ts` then `id`).
- Always emit process kinds; methods `initialize`, `authenticate`, `session/new`, `session/prompt`, `session/cancel` as `rpc` rows.
- `sessionUpdate === "tool_call"` → `tool_call` row (`name` = `toolName ?? "tool_call"`). Following consecutive `tool_call_update` increment `updateCount` (start at 0). A `tool_call_update` with no open tool row → `tool_call` row named `toolName ?? "tool_call_update"`.
- Consecutive `agent_message_chunk` / `agent_thought_chunk` collapse into one `chunks` row (`update` is the first chunk’s `sessionUpdate`; do not merge different update types into one row).
- Any other event → `rpc` row with `method: event.method ?? event.kind`.

- [ ] **Step 1: Write failing tests**

Create `tests/acp-conversations.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { AcpEvent } from "../src/acp/types";
import { conversationDetail, summarizeConversations } from "../src/acp/conversations";

function ev(over: Partial<AcpEvent> & Pick<AcpEvent, "id" | "ts" | "kind">): AcpEvent {
  return {
    bridgePid: 10,
    backendPid: 11,
    dir: null,
    rpcId: null,
    method: null,
    sessionHints: [],
    raw: "",
    truncated: false,
    parseError: null,
    ...over,
  };
}

const sessionNewRaw = JSON.stringify({
  jsonrpc: "2.0",
  id: "1",
  method: "session/new",
  params: {
    cwd: "/Users/me/SwiftMark",
    mcpServers: [{ env: { MCP_XCODE_SESSION_ID: "MCP-1" } }],
  },
});

describe("summarizeConversations", () => {
  test("groups by bridgePid and hydrates identities from raw", () => {
    const events: AcpEvent[] = [
      ev({
        id: "a",
        ts: "2026-08-15T00:00:00.000Z",
        kind: "process_start",
        bridgePid: 1,
        route: "opencode",
        raw: JSON.stringify({ route: "opencode", command: "/bin/x", args: [] }),
      }),
      ev({
        id: "b",
        ts: "2026-08-15T00:00:01.000Z",
        kind: "rpc",
        bridgePid: 1,
        dir: "c2a",
        method: "session/new",
        rpcId: "1",
        raw: sessionNewRaw,
      }),
      ev({
        id: "c",
        ts: "2026-08-15T00:00:02.000Z",
        kind: "rpc",
        bridgePid: 1,
        dir: "a2c",
        rpcId: "1",
        sessionHints: ["ses_aaa"],
        raw: JSON.stringify({ jsonrpc: "2.0", id: "1", result: { sessionId: "ses_aaa" } }),
      }),
      ev({
        id: "d",
        ts: "2026-08-15T00:00:03.000Z",
        kind: "rpc",
        bridgePid: 1,
        dir: "c2a",
        method: "session/prompt",
        raw: "{}",
      }),
      ev({
        id: "e",
        ts: "2026-08-15T00:01:00.000Z",
        kind: "process_start",
        bridgePid: 2,
        route: "other",
        raw: JSON.stringify({ route: "other" }),
      }),
    ];
    const rows = summarizeConversations(events);
    expect(rows.map((r) => r.bridgePid)).toEqual([2, 1]);
    expect(rows[1].cwd).toBe("/Users/me/SwiftMark");
    expect(rows[1].mcpXcodeSessionId).toBe("MCP-1");
    expect(rows[1].acpSessionId).toBe("ses_aaa");
    expect(rows[1].route).toBe("opencode");
    expect(rows[1].promptCount).toBe(1);
    expect(rows[1].status).toBe("live");
    expect(rows[0].status).toBe("live");
  });
});

describe("conversationDetail timeline", () => {
  test("collapses message chunks and folds tool_call_update", () => {
    const pid = 10;
    const events: AcpEvent[] = [
      ev({ id: "0", ts: "t0", kind: "process_start", route: "opencode", raw: '{"route":"opencode"}' }),
      ev({
        id: "1",
        ts: "t1",
        kind: "rpc",
        method: "session/prompt",
        dir: "c2a",
        raw: "{}",
      }),
      ev({
        id: "2",
        ts: "t2",
        kind: "rpc",
        method: "session/update",
        dir: "a2c",
        sessionUpdate: "tool_call",
        toolName: "XcodeRead",
        raw: "{}",
      }),
      ev({
        id: "3",
        ts: "t3",
        kind: "rpc",
        method: "session/update",
        dir: "a2c",
        sessionUpdate: "tool_call_update",
        toolName: "XcodeRead",
        raw: "{}",
      }),
      ev({
        id: "4",
        ts: "t4",
        kind: "rpc",
        method: "session/update",
        dir: "a2c",
        sessionUpdate: "agent_message_chunk",
        raw: "{}",
      }),
      ev({
        id: "5",
        ts: "t5",
        kind: "rpc",
        method: "session/update",
        dir: "a2c",
        sessionUpdate: "agent_message_chunk",
        raw: "{}",
      }),
      ev({ id: "6", ts: "t6", kind: "process_end", raw: "" }),
    ];
    const detail = conversationDetail(events, pid);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe("ended");
    expect(detail!.toolCallCount).toBe(1);
    const types = detail!.timeline.map((i) => i.type);
    expect(types).toEqual(["process", "rpc", "tool_call", "chunks", "process"]);
    const tool = detail!.timeline.find((i) => i.type === "tool_call");
    expect(tool).toMatchObject({ type: "tool_call", name: "XcodeRead", updateCount: 1 });
    const chunks = detail!.timeline.find((i) => i.type === "chunks");
    expect(chunks).toMatchObject({ type: "chunks", count: 2, update: "agent_message_chunk" });
  });

  test("unknown bridgePid returns null", () => {
    expect(conversationDetail([], 99)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/acp-conversations.test.ts`

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/acp/conversations.ts`**

`hydrateEvent`: if `raw` is non-empty, `JSON.parse` and `extractRpcMeta`; fill nullish `cwd`, `mcpXcodeSessionId`, `sessionUpdate`, `toolName`; if `sessionHints` is empty, use meta’s. On parse failure return the event.

Implement grouping and timeline exactly as Interfaces/Rules. Do not drop unknown methods.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/acp-conversations.test.ts tests/acp-parse.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/acp/conversations.ts tests/acp-conversations.test.ts
git commit -m "$(cat <<'EOF'
feat: aggregate ACP events into conversations and timelines

EOF
)"
```

---

### Task 5: Bridge spawn uses resolved route

**Files:**
- Modify: `src/acp/run-bridge.ts`
- Modify: `src/acp-bridge.ts`
- Modify: `tests/acp-bridge.test.ts`

**Interfaces:**
- Consumes: `parseRpcLine` meta fields; `loadAcpRouteState`, `resolveRoute`, `loadAcpBridgeConfig`
- Produces: `RunBridgeOptions.route?: string | null`. `process_start` / `process_start_error` events set `route` and include `route` in `raw` JSON when parsable. `logRpc` copies `cwd`, `mcpXcodeSessionId`, `sessionUpdate`, `toolName` from `parseRpcLine`. CLI reads route state, resolves, prints fallback to **stderr** as `acp-bridge: using default route ${name} (${reason})`, then `runBridge({ …, route: name, backendCommand, backendArgs })`.

- [ ] **Step 1: Write failing tests**

Add to `tests/acp-bridge.test.ts`:

```typescript
test("process_start raw includes route name", async () => {
  await fs.mkdir(dir, { recursive: true });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const running = runBridge({
    backendCommand: process.execPath,
    backendArgs: [fixture],
    eventsPath,
    maxRawBytes: 2 * 1024 * 1024,
    stdin,
    stdout,
    route: "opencode",
  });
  stdin.end();
  await running;
  const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const start = lines.find((e) => e.kind === "process_start");
  expect(start.route).toBe("opencode");
  expect(JSON.parse(start.raw).route).toBe("opencode");
});

test("CLI uses route state executable instead of default", async () => {
  await fs.mkdir(dir, { recursive: true });
  const cfgPath = path.join(dir, "cfg.json");
  const statePath = path.join(dir, "acp-route.json");
  await fs.writeFile(
    cfgPath,
    JSON.stringify({
      routes: {
        dead: { command: "/nonexistent-acp-backend-xyz", args: [] },
        fixture: { command: process.execPath, args: [fixture] },
      },
      defaultRoute: "dead",
      eventsPath,
      routeStatePath: statePath,
      maxRawBytes: 2 * 1024 * 1024,
    }),
  );
  await fs.writeFile(statePath, JSON.stringify({ route: "fixture" }));
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/acp-bridge.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ACP_BRIDGE_CONFIG: cfgPath },
  });
  proc.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } })}\n`,
  );
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  expect(out).toContain("protocolVersion");
  expect(code).toBe(0);
  const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.find((e) => e.kind === "process_start").route).toBe("fixture");
});
```

Keep the existing CLI test: `defaultBackend`-only config must still spawn (Task 1 compat).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/acp-bridge.test.ts`

Expected: FAIL (`route` not on `process_start` / CLI still always uses `defaultBackend`).

- [ ] **Step 3: Implement**

`RunBridgeOptions` add `route?: string | null`.

`makeEvent` defaults: `route: opts.route ?? null`, `cwd: null`, `mcpXcodeSessionId: null`, `sessionUpdate: null`, `toolName: null`.

`process_start` append:

```typescript
raw: JSON.stringify({
  route: opts.route ?? null,
  command: opts.backendCommand,
  args: opts.backendArgs,
}),
route: opts.route ?? null,
```

`process_start_error` sets `route: opts.route ?? null` and `raw` to the error message string (existing spawn-failure debugging). The `route` field is what the dashboard uses.

`logRpc`: copy meta fields from `parseRpcLine` onto the event.

`src/acp-bridge.ts`:

```typescript
import { loadAcpBridgeConfig } from "./acp/config";
import { loadAcpRouteState, resolveRoute } from "./acp/route-state";
import { runBridge } from "./acp/run-bridge";

const cfg = loadAcpBridgeConfig();
const state = loadAcpRouteState(cfg.routeStatePath);
const resolved = resolveRoute(cfg, state);
if (resolved.fallbackReason) {
  console.error(`acp-bridge: using default route ${resolved.name} (${resolved.fallbackReason})`);
}

function onSignal() {
  process.stdin.destroy();
}
process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);

const { code } = await runBridge({
  backendCommand: resolved.backend.command,
  backendArgs: resolved.backend.args,
  eventsPath: cfg.eventsPath,
  maxRawBytes: cfg.maxRawBytes,
  stdin: process.stdin,
  stdout: process.stdout,
  route: resolved.name,
});
process.exit(code);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/acp-bridge.test.ts tests/acp-parse.test.ts tests/acp-config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/acp/run-bridge.ts src/acp-bridge.ts tests/acp-bridge.test.ts
git commit -m "$(cat <<'EOF'
feat: spawn the ACP backend chosen for the next conversation

EOF
)"
```

---

### Task 6: Dashboard APIs for route and conversations

**Files:**
- Modify: `src/dashboard/acp-routes.ts`
- Modify: `src/index.ts`
- Modify: `tests/acp-dashboard.test.ts`

**Interfaces:**
- Consumes: `AcpBridgeConfig`, `loadAcpRouteState`, `writeAcpRouteState`, `resolveRoute`, `summarizeConversations`, `conversationDetail`
- Produces:

```typescript
export type AcpDashboardDeps = { config: AcpBridgeConfig };

export function createAcpDashboardApp(
  store: AcpEventStore,
  hub?: EventHub,
  deps?: AcpDashboardDeps,
): Hono;
```

`deps` is required for the new endpoints. Existing tests must pass a deps object (add a helper). `src/index.ts` passes `{ config: acpCfg }`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/acp-route` | `{ route, defaultRoute, routes: string[], source: "state" \| "default" }` using `resolveRoute`. `source` is `"state"` iff `fallbackReason === null` |
| PUT | `/api/acp-route` | JSON `{ route: string }`. If not a key of `config.routes`, 400 `{ error: "unknown route" }`. Else `writeAcpRouteState` and 200 same shape as GET with `source: "state"` |
| GET | `/api/acp-conversations` | `summarizeConversations(store.list())` |
| GET | `/api/acp-conversations/:bridgePid` | `conversationDetail(store.list(), Number(bridgePid))` or 404 `{ error: "not found" }` |

Keep existing events/SSE/clear/export.

- [ ] **Step 1: Write failing dashboard tests**

Add a helper at the top of `tests/acp-dashboard.test.ts` and use it in **every** `createAcpDashboardApp` call:

```typescript
import { loadAcpBridgeConfig } from "../src/acp/config";
import type { AcpBridgeConfig } from "../src/acp/types";

function testConfig(): AcpBridgeConfig {
  return {
    routes: {
      opencode: { command: "/bin/echo", args: ["acp"] },
      other: { command: "/bin/true", args: [] },
    },
    defaultRoute: "opencode",
    defaultBackend: { command: "/bin/echo", args: ["acp"] },
    eventsPath,
    routeStatePath: path.join(dir, "acp-route.json"),
    maxRawBytes: 99,
  };
}

function acpApp(store: AcpEventStore, hub?: EventHub) {
  return createAcpDashboardApp(store, hub ?? new EventHub(), { config: testConfig() });
}
```

Replace `createAcpDashboardApp(store)` / `(store, hub)` with `acpApp(...)`.

Add tests:

```typescript
test("GET /api/acp-route falls back to defaultRoute", async () => {
  const store = new AcpEventStore(eventsPath);
  const app = acpApp(store);
  const res = await app.request("http://127.0.0.1/api/acp-route");
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.route).toBe("opencode");
  expect(body.source).toBe("default");
  expect(body.routes).toContain("other");
});

test("PUT /api/acp-route persists and GET reads it", async () => {
  const store = new AcpEventStore(eventsPath);
  const app = acpApp(store);
  const put = await app.request("http://127.0.0.1/api/acp-route", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ route: "other" }),
  });
  expect(put.status).toBe(200);
  expect((await put.json()).source).toBe("state");
  const get = await app.request("http://127.0.0.1/api/acp-route");
  expect((await get.json()).route).toBe("other");
});

test("PUT unknown route returns 400 and does not write", async () => {
  const store = new AcpEventStore(eventsPath);
  const app = acpApp(store);
  const put = await app.request("http://127.0.0.1/api/acp-route", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ route: "nope" }),
  });
  expect(put.status).toBe(400);
  const get = await app.request("http://127.0.0.1/api/acp-route");
  expect((await get.json()).route).toBe("opencode");
});

test("GET /api/acp-conversations groups events", async () => {
  const store = new AcpEventStore(eventsPath);
  await store.append(
    ev({
      id: "p",
      kind: "process_start",
      bridgePid: 42,
      route: "opencode",
      raw: JSON.stringify({ route: "opencode" }),
    }),
  );
  const app = acpApp(store);
  const body = await (await app.request("http://127.0.0.1/api/acp-conversations")).json();
  expect(body).toHaveLength(1);
  expect(body[0].bridgePid).toBe(42);
});

test("GET /api/acp-conversations/:pid 404s when missing", async () => {
  const store = new AcpEventStore(eventsPath);
  const app = acpApp(store);
  const res = await app.request("http://127.0.0.1/api/acp-conversations/999");
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/acp-dashboard.test.ts`

Expected: FAIL (new routes 404).

- [ ] **Step 3: Implement**

If `deps` is missing, new endpoints still 500 — do not do that. Always pass `deps` from tests and `index.ts`.

Implement GET/PUT as specified. PUT: parse JSON; if `typeof route !== "string"` → 400. `writeAcpRouteState(deps.config.routeStatePath, { route })`.

Register `/api/acp-conversations/:bridgePid` **before** any wildcard. `Number(pid)`; if `Number.isNaN`, 404.

`src/index.ts`: `createAcpDashboardApp(acpStore, acpHub, { config: acpCfg })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/acp-dashboard.test.ts tests/acp-conversations.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/acp-routes.ts src/index.ts tests/acp-dashboard.test.ts
git commit -m "$(cat <<'EOF'
feat: expose ACP conversation and next-route dashboard APIs

EOF
)"
```

---

### Task 7: ACP tab UI + README

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 6 APIs
- Produces: ACP tab shows route bar + conversation rows; detail is header + timeline + raw disclosure. HTTP tab unchanged.

- [ ] **Step 1: Rewrite ACP panel markup**

In `public/index.html` replace `#acp-panel` contents with:

```html
<section class="list-panel hidden" id="acp-panel">
  <div class="route-bar">
    <label for="acp-next-route">Next conversation</label>
    <select id="acp-next-route"></select>
    <span class="hint">Applies to the next Xcode conversation. The current one is unchanged.</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Started</th>
        <th>Route</th>
        <th>Project</th>
        <th>Prompts</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody id="acp-conversation-list"></tbody>
  </table>
</section>
```

Remove `#acp-list` (event table). Keep HTTP table.

- [ ] **Step 2: Add CSS**

Append to `public/styles.css`:

```css
.route-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #ddd;
  font-size: 0.875rem;
}

.route-bar .hint {
  color: #666;
  font-size: 0.75rem;
}

.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
}

.timeline li {
  padding: 0.4rem 0;
  border-bottom: 1px solid #eee;
  cursor: pointer;
  font-size: 0.875rem;
}

.timeline li.selected {
  background: #e8f0fe;
}

.status-live {
  color: #0b7a43;
}

.status-error {
  color: #b00020;
}

details.raw-events {
  margin-top: 1rem;
}
```

- [ ] **Step 3: Implement ACP UI in `public/app.js`**

Replace ACP list/detail logic. Keep HTTP logic.

State:

```javascript
let acpConversations = [];
let acpSelectedPid = null;
let acpDetail = null;
let acpRoute = null;
```

Functions (implement exactly these behaviors):

- `projectName(cwd)` → basename after last `/`, or `—`
- `loadAcpRoute()` → GET `/api/acp-route`, fill `#acp-next-route` options from `routes`, select `route`
- `loadAcpConversations()` → GET `/api/acp-conversations`, `renderAcpConversations()`
- `renderAcpConversations()` → rows from `acpConversations`; click sets `acpSelectedPid` and `loadAcpDetail(pid)`
- `loadAcpDetail(pid)` → GET `/api/acp-conversations/${pid}`, store `acpDetail`, `renderAcpDetail()`
- `timelineLabel(item)`:
  - process: `item.kind` plus route if present
  - rpc: `item.method`
  - tool_call: `tool ${item.name}` plus ` +${item.updateCount} updates` if `updateCount > 0`
  - chunks: `${item.count} ${item.update}s`
- `renderAcpDetail()` → header fields (`bridgePid`, `backendPid`, `route`, `cwd`, `mcpXcodeSessionId`, `acpSessionId`) + `<ol class="timeline">` + `<details class="raw-events"><summary>Raw events</summary>` listing `eventId`s from every timeline item (chunk groups: join `eventIds`). Clicking a timeline row fetches GET `/api/acp-events`, finds that `eventId` (for chunks, last id), renders `raw` in a `<pre>` under the header.
- `#acp-next-route` `change` → PUT `/api/acp-route` with `{ route: select.value }`, then `loadAcpRoute()`
- Clear on ACP tab: existing POST clear, then `acpConversations = []`, `acpDetail = null`, `acpSelectedPid = null`, re-render
- SSE `acp`: call `loadAcpConversations()`; if `acpSelectedPid` still exists, `loadAcpDetail(acpSelectedPid)`
- On `setActiveTab("acp")`, if `acpSelectedPid` re-render detail

Do not break HTTP EventSource handlers.

- [ ] **Step 4: Update README**

In the ACP Agent section, after the Xcode fill-in table, add:

- ACP tab lists **conversations** (one row per Xcode spawn / `bridgePid`), not every JSON-RPC line.
- Detail shows `cwd`, `MCP_XCODE_SESSION_ID`, OpenCode `sessionId`, and a timeline with tool calls; `session/update` chunks are collapsed.
- **Next conversation** dropdown chooses which `routes` entry the **next** Xcode conversation will spawn. The live conversation does not switch.
- To add a backend, edit `acp-bridge.config.json`:

```json
"routes": {
  "opencode": {
    "command": "~/.opencode/bin/opencode",
    "args": ["acp"]
  },
  "other": {
    "command": "/absolute/path/to/agent",
    "args": ["acp"]
  }
}
```

Then pick `other` in the dashboard and start a **New Conversation** in Xcode.

Add API rows:

| Endpoint | Purpose |
|---|---|
| `GET /api/acp-route` | Next-spawn route + available names |
| `PUT /api/acp-route` | Set next-spawn route |
| `GET /api/acp-conversations` | Conversation summaries |
| `GET /api/acp-conversations/:bridgePid` | Timeline for one spawn |

Remove the old “inspect raw events and note ids” checklist items 5’s open questions; replace with the spec’s manual acceptance 1–4 as a short list.

- [ ] **Step 5: Run the full suite**

Run: `bun test`

Expected: all existing + new tests PASS. There is no JS DOM test; do not add a browser runner.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js public/styles.css README.md
git commit -m "$(cat <<'EOF'
feat: show ACP conversations and next-route picker in the dashboard

EOF
)"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| Config `routes` / `defaultRoute` / `routeStatePath` / `defaultBackend` compat | 1 |
| `data/acp-route.json` + resolve at spawn | 2, 5 |
| Identity fields + `sessionHints` include MCP id | 3 |
| Conversation model + timeline collapse | 4 |
| `process_start.route`, stderr fallback, CLI | 5 |
| Dashboard APIs | 6 |
| Conversation UI + next-route select + README | 7 |
| Out of scope (SDK, rewrite, hot-swap, HTTP-as-agent) | no task |
| Existing tee / HTTP observer | untouched except additive fields |

## Placeholder scan

None: no TBD, no “add error handling later”, no “similar to Task N”.
