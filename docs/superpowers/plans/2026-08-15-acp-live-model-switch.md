# ACP Live Model Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the model of a **live** ACP conversation from the dashboard (same backend): PUT writes a command file keyed by `bridgePid`; the running bridge injects `session/set_config_option` mid-conversation. Session-only — does not write `data/acp-route.json`.

**Architecture:** `src/acp/commands.ts` owns the `data/acp-commands/<bridgePid>.json` file protocol (`{ model, ts }`, atomic rename). `runBridge` watches that directory (`fs.watch`) and also stats the file on every c2a line. When `lastSessionId` is known it injects with id `bridge-live-<n>` into the existing `injectedIds` suppression path. Dashboard `PUT /api/acp-conversations/:bridgePid/model` writes the file for live conversations only (409 if ended). Detail pane turns the model field into a select; list column stays read-only and updates via SSE.

**Tech Stack:** Bun, TypeScript, Hono, `bun:test`, existing dashboard HTML/JS. Node `fs.watch` / `statSync` / `renameSync`.

**Spec:** `docs/superpowers/specs/2026-08-15-acp-live-model-switch-design.md`

## Global Constraints

- Addressed by **bridgePid** (live conversation ⇔ bridge process is 1:1). Never key off `acpSessionId`.
- Live switch is **session-only**: must not write `data/acp-route.json` / `routeStatePath`.
- Command dir is derived from `eventsPath`: `path.join(path.dirname(eventsPath), "acp-commands")`. No new config field.
- Command file `{ "model": string, "ts": number }`. Ignore `ts < startedAtMs` (PID reuse). Ignore unreadable/invalid JSON.
- Injected live request ids: `bridge-live-<n>`. Session-start injection stays `bridge-<n>`. Both go in `injectedIds`; responses are logged and **never** forwarded to client stdout.
- `appliedModel` is set **at write time** (not when the agent replies) to prevent retry loops. User re-picks to retry a failed apply.
- Inject immediately even mid-turn. No turn-boundary queue. Next prompt uses the new model (agent-defined for in-flight turn).
- Watch the **directory** (file may not exist at start). Close the watcher on exit or tests hang (`fs.watch` keeps the event loop alive). Best-effort unlink of own command file on exit.
- Forwarded bytes stay unchanged except the added injected request on backend stdin.
- UI: live + known `route` → select in **detail header only**. List Model column is read-only. Ended/error conversations stay plain text.
- Out of scope: switching backend/route live, sockets, write-through, retry/ack, mode switching.

---

## File map

| Path | Responsibility |
|---|---|
| `src/acp/commands.ts` | command-file path helpers + atomic write/read |
| `src/acp/run-bridge.ts` | watch + c2a stat fallback + live inject (`bridge-live-<n>`) |
| `tests/fixtures/acp-fake-agent.ts` | `session/resume` / `session/load` so resume tests have an agent reply |
| `src/dashboard/acp-routes.ts` | `PUT /api/acp-conversations/:bridgePid/model` |
| `public/app.js` | live-model select in detail header + SSE focus guard |
| `public/index.html` | update the "current conversation unchanged" hint |
| `public/styles.css` | tiny select/hint styling in the detail header if the unstyled select looks broken |
| `README.md` | live-switch behavior + API row |
| `tests/acp-commands.test.ts` | new: write/read/invalid |
| `tests/acp-bridge.test.ts` | extend: mid-session, before session/new, stale ts, dedupe, resume |
| `tests/acp-dashboard.test.ts` | extend: 200/409/404/400 + route state untouched |

`src/acp-bridge.ts` is unchanged (default command dir from `eventsPath` is enough). `src/acp/conversations.ts` is unchanged (`model` already `lastNonNull(modelCurrent)`).

---

### Task 1: Command file module

**Files:**
- Create: `src/acp/commands.ts`
- Test: `tests/acp-commands.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export type AcpModelCommand = { model: string; ts: number }`
  - `export function commandsDirFor(eventsPath: string): string`
  - `export function writeModelCommand(eventsPath: string, bridgePid: number, model: string): void`
  - `export function readModelCommand(filePath: string): AcpModelCommand | null`

- [ ] **Step 1: Write the failing tests**

Create `tests/acp-commands.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { commandsDirFor, readModelCommand, writeModelCommand } from "../src/acp/commands";

const dir = path.join(import.meta.dir, ".tmp-acp-commands");
const eventsPath = path.join(dir, "acp-events.jsonl");

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("commandsDirFor", () => {
  test("places acp-commands next to the events file", () => {
    expect(commandsDirFor(eventsPath)).toBe(path.join(dir, "acp-commands"));
  });
});

describe("writeModelCommand / readModelCommand", () => {
  test("roundtrip writes {model, ts} atomically (no leftover tmp)", () => {
    writeModelCommand(eventsPath, 42, "fixture/model-b");
    const dest = path.join(commandsDirFor(eventsPath), "42.json");
    const parsed = readModelCommand(dest);
    expect(parsed).not.toBeNull();
    expect(parsed!.model).toBe("fixture/model-b");
    expect(typeof parsed!.ts).toBe("number");
    expect(parsed!.ts).toBeGreaterThan(0);
    const names = fs.readdirSync(commandsDirFor(eventsPath));
    expect(names).toEqual(["42.json"]);
  });

  test("returns null for missing file, invalid JSON, and bad shape", () => {
    expect(readModelCommand(path.join(dir, "missing.json"))).toBeNull();
    fs.mkdirSync(dir, { recursive: true });
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not-json");
    expect(readModelCommand(bad)).toBeNull();
    fs.writeFileSync(bad, JSON.stringify({ model: "", ts: Date.now() }));
    expect(readModelCommand(bad)).toBeNull();
    fs.writeFileSync(bad, JSON.stringify({ model: "x", ts: "nope" }));
    expect(readModelCommand(bad)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/acp-commands.test.ts`

Expected: FAIL with `Cannot find module '../src/acp/commands'` (or `commandsDirFor is not defined`).

- [ ] **Step 3: Write minimal implementation**

Create `src/acp/commands.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";

export type AcpModelCommand = { model: string; ts: number };

export function commandsDirFor(eventsPath: string): string {
  return path.join(path.dirname(eventsPath), "acp-commands");
}

export function writeModelCommand(eventsPath: string, bridgePid: number, model: string): void {
  const dir = commandsDirFor(eventsPath);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${bridgePid}.json`);
  const tmp = path.join(dir, `${bridgePid}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const payload: AcpModelCommand = { model, ts: Date.now() };
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, dest);
}

export function readModelCommand(filePath: string): AcpModelCommand | null {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.model !== "string" || rec.model.length === 0) return null;
    if (typeof rec.ts !== "number" || !Number.isFinite(rec.ts)) return null;
    return { model: rec.model, ts: rec.ts };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/acp-commands.test.ts`

Expected: PASS (2 describes, 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/acp/commands.ts tests/acp-commands.test.ts
git commit -m "feat: add acp command-file protocol for live model switch"
```

---

### Task 2: Bridge watches command file and injects live

**Files:**
- Modify: `src/acp/run-bridge.ts`
- Modify: `tests/fixtures/acp-fake-agent.ts` (add `session/resume` + `session/load`)
- Test: `tests/acp-bridge.test.ts`

**Interfaces:**
- Consumes: `commandsDirFor`, `readModelCommand` from Task 1; existing `pendingModel` + `injectedIds` injection path
- Produces:
  - `RunBridgeOptions.commandsDir?: string` (default `commandsDirFor(eventsPath)`)
  - Live inject RPC id pattern `bridge-live-<n>`
  - `lastSessionId` from c2a `session/new|resume|load` `params.sessionId` and a2c `session/new` `result.sessionId`

Do not change the session-start injection (`bridge-<n>` after `session/new`). Live inject is additive.

- [ ] **Step 1: Extend fake-agent with resume/load**

In `tests/fixtures/acp-fake-agent.ts`, widen the parsed message type and add handlers **before** the `session/prompt` branch:

```typescript
await readLines((line) => {
  let msg: {
    id?: unknown;
    method?: string;
    params?: { configId?: unknown; value?: unknown; sessionId?: unknown };
  };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    return;
  }
  if (msg.method === "session/new") {
    reply(msg.id, { sessionId: "sess-fixture", configOptions: configOptions() });
    return;
  }
  if (msg.method === "session/resume" || msg.method === "session/load") {
    const sessionId =
      typeof msg.params?.sessionId === "string" && msg.params.sessionId.length > 0
        ? msg.params.sessionId
        : "sess-fixture";
    reply(msg.id, { sessionId, configOptions: configOptions() });
    return;
  }
  if (msg.method === "session/set_config_option") {
    // ... existing body unchanged ...
```

- [ ] **Step 2: Write the failing bridge tests**

Append inside `describe("runBridge", …)` in `tests/acp-bridge.test.ts`. Add this import at the top of the file:

```typescript
import { commandsDirFor, writeModelCommand } from "../src/acp/commands";
```

Then these tests (they will fail: no live inject exists yet):

```typescript
  function liveInjects(lines: Array<Record<string, unknown>>) {
    return lines.filter(
      (e) =>
        e.dir === "c2a" &&
        e.method === "session/set_config_option" &&
        String(e.rpcId).startsWith("bridge-live-"),
    );
  }

  test("live command file after session/new injects set_config_option", async () => {
    await fs.mkdir(dir, { recursive: true });
    const stdin = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c) => stdoutChunks.push(c as Buffer));
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin,
      stdout,
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    writeModelCommand(eventsPath, process.pid, "fixture/model-b");
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sess-fixture", prompt: [] } })}\n`,
    );
    await Bun.sleep(300);
    stdin.end();
    await running;
    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const live = liveInjects(lines);
    expect(live).toHaveLength(1);
    expect(JSON.parse(live[0]!.raw).params.value).toBe("fixture/model-b");
    expect(JSON.parse(live[0]!.raw).params.sessionId).toBe("sess-fixture");
    const a2c = lines.find((e) => e.dir === "a2c" && String(e.rpcId).startsWith("bridge-live-"));
    expect(a2c).toBeTruthy();
    expect(a2c.modelCurrent).toBe("fixture/model-b");
    const out = Buffer.concat(stdoutChunks).toString("utf8");
    expect(out).toContain("end_turn");
    expect(out).not.toContain("bridge-live-");
  });

  test("command file written before session/new is applied once session id is known", async () => {
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
    });
    await Bun.sleep(50);
    writeModelCommand(eventsPath, process.pid, "fixture/model-b");
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(300);
    stdin.end();
    await running;
    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const live = liveInjects(lines);
    expect(live).toHaveLength(1);
    expect(JSON.parse(live[0]!.raw).params.sessionId).toBe("sess-fixture");
    expect(JSON.parse(live[0]!.raw).params.value).toBe("fixture/model-b");
  });

  test("stale command file ts older than bridge start is ignored", async () => {
    await fs.mkdir(dir, { recursive: true });
    const commandsDir = commandsDirFor(eventsPath);
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.writeFile(
      path.join(commandsDir, `${process.pid}.json`),
      JSON.stringify({ model: "fixture/model-b", ts: Date.now() - 60_000 }),
    );
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin,
      stdout,
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sess-fixture", prompt: [] } })}\n`,
    );
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(liveInjects(lines)).toHaveLength(0);
  });

  test("repeated same live model is applied once", async () => {
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
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    writeModelCommand(eventsPath, process.pid, "fixture/model-b");
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sess-fixture", prompt: [] } })}\n`,
    );
    await Bun.sleep(200);
    writeModelCommand(eventsPath, process.pid, "fixture/model-b");
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "sess-fixture", prompt: [] } })}\n`,
    );
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(liveInjects(lines)).toHaveLength(1);
  });

  test("live switch works on session/resume without session/new", async () => {
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
    });
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/resume", params: { sessionId: "sess-resume-1" } })}\n`,
    );
    await Bun.sleep(200);
    writeModelCommand(eventsPath, process.pid, "fixture/model-b");
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sess-resume-1", prompt: [] } })}\n`,
    );
    await Bun.sleep(300);
    stdin.end();
    await running;
    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const live = liveInjects(lines);
    expect(live).toHaveLength(1);
    expect(JSON.parse(live[0]!.raw).params.sessionId).toBe("sess-resume-1");
    expect(lines.some((e) => e.method === "session/new")).toBe(false);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/acp-bridge.test.ts`

Expected: the five new tests FAIL on `liveInjects(…).toHaveLength(1)` (got 0). The existing session-start injection tests must still pass.

- [ ] **Step 4: Implement live watch + inject in `run-bridge.ts`**

Imports at top of `src/acp/run-bridge.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { AcpEventStore } from "./event-store";
import { parseRpcLine } from "./parse";
import { commandsDirFor, readModelCommand } from "./commands";
import type { AcpDir, AcpEvent } from "./types";
```

Add to `RunBridgeOptions`:

```typescript
  commandsDir?: string;
```

Add helper next to `sessionIdFromNewResultRaw`:

```typescript
const SESSION_ID_METHODS = new Set(["session/new", "session/resume", "session/load"]);

function sessionIdFromRequestRaw(method: string | null, line: string): string | null {
  if (method === null || !SESSION_ID_METHODS.has(method)) return null;
  try {
    const msg: unknown = JSON.parse(line);
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return null;
    const params = (msg as Record<string, unknown>).params;
    if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
    const sessionId = (params as Record<string, unknown>).sessionId;
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
  } catch {
    return null;
  }
}
```

Inside `runBridge`, after `pendingModel` / `injectedIds` / `injectSeq` are declared, add state. Then **after a successful spawn** (after `pumpBackendStderr`), create the command dir, watcher, and apply helpers. Skeleton to insert **before** `logRpc`:

```typescript
  const startedAtMs = Date.now();
  const commandsDir = opts.commandsDir ?? commandsDirFor(opts.eventsPath);
  const commandFileName = `${bridgePid}.json`;
  const commandFilePath = path.join(commandsDir, commandFileName);
  fs.mkdirSync(commandsDir, { recursive: true });

  let lastSessionId: string | null = null;
  let appliedModel: string | null = pendingModel;
  let desiredLiveModel: string | null = null;
  let lastCommandMtime = 0;
  let liveInjectSeq = 0;
  let watcher: fs.FSWatcher | null = null;
```

`logRpc` stays as-is. Add `maybeApplyLiveModel` and `pollCommandFile` **after** `logRpc` (they need `logRpc` + `proc`):

```typescript
  const maybeApplyLiveModel = async (): Promise<void> => {
    if (lastSessionId === null) return;
    if (desiredLiveModel === null || desiredLiveModel === appliedModel) return;
    const injectId = `bridge-live-${++liveInjectSeq}`;
    injectedIds.add(injectId);
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: injectId,
      method: "session/set_config_option",
      params: {
        sessionId: lastSessionId,
        configId: "model",
        type: "select",
        value: desiredLiveModel,
      },
    });
    appliedModel = desiredLiveModel;
    await logRpc("c2a", request);
    proc.stdin.write(`${request}\n`);
  };

  const pollCommandFile = async (): Promise<void> => {
    let mtime = 0;
    try {
      mtime = fs.statSync(commandFilePath).mtimeMs;
    } catch {
      return;
    }
    if (mtime === lastCommandMtime) return;
    lastCommandMtime = mtime;
    const cmd = readModelCommand(commandFilePath);
    if (!cmd || cmd.ts < startedAtMs) return;
    if (cmd.model === desiredLiveModel) return;
    desiredLiveModel = cmd.model;
    await maybeApplyLiveModel();
  };

  let pollChain = Promise.resolve();
  const schedulePoll = (): void => {
    pollChain = pollChain.then(pollCommandFile);
  };

  try {
    watcher = fs.watch(commandsDir, (_event, filename) => {
      if (filename != null && filename !== commandFileName) return;
      schedulePoll();
    });
  } catch {
    // c2a stat fallback remains
  }
```

Change the **c2a** splitter to update `lastSessionId`, poll, then forward:

```typescript
  const c2aSplitter = splitLines(async (line) => {
    const parsed = await logRpc("c2a", line);
    const fromRequest = sessionIdFromRequestRaw(parsed.method, line);
    if (fromRequest) lastSessionId = fromRequest;
    if (pendingModel !== null && parsed.method === "session/new" && parsed.rpcId !== null) {
      sessionNewIds.add(parsed.rpcId);
    }
    await pollCommandFile();
    await maybeApplyLiveModel();
    proc.stdin.write(`${line}\n`);
  });
```

Change the **a2c** splitter so that after forwarding `session/new` (and after the existing pending-model inject), it records `lastSessionId` and applies any pending live model. Keep injected-id suppression unchanged:

```typescript
  const a2cSplitter = splitLines(async (line) => {
    const parsed = await logRpc("a2c", line);
    if (parsed.rpcId !== null && injectedIds.has(String(parsed.rpcId))) {
      return; // response to a bridge-injected request: logged, never forwarded
    }
    opts.stdout.write(`${line}\n`);
    const fromNew = sessionIdFromNewResultRaw(line);
    if (fromNew) lastSessionId = fromNew;
    if (pendingModel !== null && parsed.rpcId !== null && sessionNewIds.has(parsed.rpcId)) {
      sessionNewIds.delete(parsed.rpcId);
      const sessionId = fromNew;
      if (sessionId !== null && !injectedSessions.has(sessionId)) {
        injectedSessions.add(sessionId);
        const injectId = `bridge-${++injectSeq}`;
        injectedIds.add(injectId);
        const request = JSON.stringify({
          jsonrpc: "2.0",
          id: injectId,
          method: "session/set_config_option",
          params: { sessionId, configId: "model", type: "select", value: pendingModel },
        });
        await logRpc("c2a", request);
        proc.stdin.write(`${request}\n`);
      }
    }
    await maybeApplyLiveModel();
  });
```

Close the watcher and unlink the command file on the way out — **after** `await proc.exited` / `appendProcessEnd`, before `return`. Use a `try/finally` around the pump so a test `stdin.end()` always releases the watcher:

```typescript
  try {
    await Promise.race([stdinClosed, proc.exited]);
    const code = await proc.exited;
    await appendProcessEnd();
    if (typeof opts.stdout.end === "function") {
      opts.stdout.end();
    }
    await backendOutDone;
    return { code: killedByStdin ? 0 : (code ?? 1) };
  } finally {
    watcher?.close();
    try {
      fs.unlinkSync(commandFilePath);
    } catch {
      // leftover is ignored next spawn via ts < startedAtMs
    }
  }
```

If the spawn `catch` still returns `{ code: 1 }` before the watcher exists, leave that path as-is (`watcher` is still null).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/acp-bridge.test.ts tests/acp-commands.test.ts`

Expected: PASS. If a test hangs, the watcher was not closed — fix that first, do not lengthen sleeps past 500ms.

- [ ] **Step 6: Commit**

```bash
git add src/acp/run-bridge.ts tests/acp-bridge.test.ts tests/fixtures/acp-fake-agent.ts
git commit -m "feat: inject live set_config_option from command file"
```

---

### Task 3: Dashboard PUT for live model

**Files:**
- Modify: `src/dashboard/acp-routes.ts`
- Test: `tests/acp-dashboard.test.ts`

**Interfaces:**
- Consumes: `writeModelCommand` + `commandsDirFor` from Task 1; `conversationDetail` (status `live` | `ended` | `error`)
- Produces: `PUT /api/acp-conversations/:bridgePid/model` with body `{ model: string }`
  - 400 if `model` is missing / not a non-empty string
  - 404 if no conversation for that pid
  - 409 `{ error: "conversation not live" }` if `status !== "live"`
  - 200 `{ ok: true, bridgePid, model }` and writes the command file
  - does **not** write `routeStatePath`

- [ ] **Step 1: Write the failing dashboard tests**

Add this import in `tests/acp-dashboard.test.ts`:

```typescript
import { commandsDirFor, readModelCommand } from "../src/acp/commands";
```

Append inside the existing `describe` (same file as the other `/api/acp-conversations` tests):

```typescript
  test("PUT /api/acp-conversations/:pid/model writes command file for live sessions", async () => {
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
    const res = await app.request("http://127.0.0.1/api/acp-conversations/42/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixture/model-b" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, bridgePid: 42, model: "fixture/model-b" });
    const dest = path.join(commandsDirFor(eventsPath), "42.json");
    expect(readModelCommand(dest)?.model).toBe("fixture/model-b");
  });

  test("PUT live model does not write route state", async () => {
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
    await app.request("http://127.0.0.1/api/acp-conversations/42/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixture/model-b" }),
    });
    const statePath = path.join(dir, "acp-route.json");
    expect(await fs.exists(statePath)).toBe(false);
  });

  test("PUT /api/acp-conversations/:pid/model 409s when ended", async () => {
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
    await store.append(ev({ id: "e", kind: "process_end", bridgePid: 42 }));
    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-conversations/42/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixture/model-b" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("conversation not live");
  });

  test("PUT /api/acp-conversations/:pid/model 404s when missing", async () => {
    const store = new AcpEventStore(eventsPath);
    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-conversations/999/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixture/model-b" }),
    });
    expect(res.status).toBe(404);
  });

  test("PUT /api/acp-conversations/:pid/model 400s on bad body", async () => {
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
    const missing = await app.request("http://127.0.0.1/api/acp-conversations/42/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    const empty = await app.request("http://127.0.0.1/api/acp-conversations/42/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "" }),
    });
    expect(empty.status).toBe(400);
    const notString = await app.request("http://127.0.0.1/api/acp-conversations/42/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: 42 }),
    });
    expect(notString.status).toBe(400);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/acp-dashboard.test.ts`

Expected: the new PUT tests FAIL with 404 (Hono has no such route yet). Existing GET conversation + route tests still pass.

- [ ] **Step 3: Implement the route**

In `src/dashboard/acp-routes.ts`, add:

```typescript
import { writeModelCommand } from "../acp/commands";
```

Register this **PUT** next to the existing `GET /api/acp-conversations/:bridgePid` (Hono matches method + path, so GET `:bridgePid` does not collide):

```typescript
  app.put("/api/acp-conversations/:bridgePid/model", async (c) => {
    const pid = Number(c.req.param("bridgePid"));
    if (Number.isNaN(pid)) {
      return c.json({ error: "not found" }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid model" }, 400);
    }
    const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const model = rec.model;
    if (typeof model !== "string" || model.length === 0) {
      return c.json({ error: "invalid model" }, 400);
    }
    const detail = conversationDetail(store.list(), pid);
    if (!detail) {
      return c.json({ error: "not found" }, 404);
    }
    if (detail.status !== "live") {
      return c.json({ error: "conversation not live" }, 409);
    }
    writeModelCommand(config.eventsPath, pid, model);
    return c.json({ ok: true, bridgePid: pid, model });
  });
```

Do **not** call `writeAcpRouteState`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/acp-dashboard.test.ts tests/acp-bridge.test.ts tests/acp-commands.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/acp-routes.ts tests/acp-dashboard.test.ts
git commit -m "feat: PUT live conversation model via command file"
```

---

### Task 4: Dashboard UI + README

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `public/styles.css` (only if the unstyled header select is cramped; keep it to a few rules)
- Modify: `README.md`

**Interfaces:**
- Consumes: `GET /api/acp-models?route=`, `PUT /api/acp-conversations/:bridgePid/model`, existing `d.status` / `d.route` / `d.model`
- Produces: live-only `<select id="acp-live-model">` in the detail header; `#acp-live-model-status` for errors; SSE skip while that select is focused

No bun tests for the DOM (same as previous dashboard UI work). Be conservative: list Model column stays read-only text.

- [ ] **Step 1: Fix the route-bar copy**

In `public/index.html`, replace the hint that now lies:

```html
          <span class="hint">Next conversation selections apply to the next Xcode spawn. Switch the current conversation's model in the detail pane while it is live.</span>
```

- [ ] **Step 2: Live-model select in the detail header**

In `public/app.js`, add state next to `acpTimelineFetchSeq`:

```javascript
let acpLiveModelFocused = false;
const acpLiveModelsCache = new Map();
```

Replace the model line in `renderAcpDetail` (`<p><strong>model:</strong> ${dash(d.model)}</p>`) with:

```javascript
      <p><strong>model:</strong> ${
        d.status === "live" && d.route
          ? `<select id="acp-live-model"></select><span id="acp-live-model-status" class="hint"></span>`
          : dash(d.model)
      }</p>
```

After `detailEl.innerHTML = \`…\`` (still inside `renderAcpDetail`), wire the select:

```javascript
  const liveEl = document.getElementById("acp-live-model");
  if (liveEl) bindAcpLiveModel(liveEl, d);
```

Add these functions near `loadAcpModels`:

```javascript
async function modelsForRoute(route) {
  if (!route) return [];
  const data = await fetch(`/api/acp-models?route=${encodeURIComponent(route)}`).then((r) => r.json());
  const models = data.models ?? [];
  acpLiveModelsCache.set(route, models);
  return models;
}

function fillLiveModelSelect(selectEl, models, current) {
  selectEl.innerHTML = [
    `<option value="">(backend default)</option>`,
    ...models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`),
  ].join("");
  selectEl.value = current ?? "";
}

function bindAcpLiveModel(selectEl, d) {
  selectEl.addEventListener("focusin", () => {
    acpLiveModelFocused = true;
  });
  selectEl.addEventListener("focusout", () => {
    acpLiveModelFocused = false;
  });
  fillLiveModelSelect(selectEl, acpLiveModelsCache.get(d.route) ?? [], d.model);
  void modelsForRoute(d.route).then((models) => {
    if (document.getElementById("acp-live-model") !== selectEl) return;
    fillLiveModelSelect(selectEl, models, d.model);
  });
  selectEl.addEventListener("change", async () => {
    const statusEl = document.getElementById("acp-live-model-status");
    if (statusEl) statusEl.textContent = "";
    const model = selectEl.value;
    if (!model) {
      selectEl.value = d.model ?? "";
      if (statusEl) statusEl.textContent = "pick a model to switch";
      return;
    }
    const res = await fetch(`/api/acp-conversations/${d.bridgePid}/model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (res.ok) return;
    selectEl.value = d.model ?? "";
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") msg = body.error;
    } catch {
      // keep HTTP status
    }
    if (statusEl) statusEl.textContent = msg;
  });
}
```

In the ACP SSE handler (`acpEs.addEventListener("acp", …)`), skip the deferred `loadAcpDetail` when the live select is focused, same placement as the `acpSelectedEventId` guard:

```javascript
  if (acpSelectedEventId != null) return;
  if (acpLiveModelFocused) return;
```

And inside the 400ms timeout callback:

```javascript
    if (acpSelectedPid == null || acpSelectedEventId != null || acpLiveModelFocused) return;
```

Do **not** change `conversationRowHtml` — `${dash(c.model)}` stays text.

If the header select needs a little room, add to `public/styles.css`:

```css
.acp-detail-header select {
  margin-left: 0.4rem;
}
#acp-live-model-status {
  margin-left: 0.5rem;
}
```

- [ ] **Step 3: README**

Update the ACP Bridge bullets (around the current "The live conversation does not switch" sentence) to:

```markdown
- **Next conversation** dropdowns choose the `routes` entry **and the model** the **next** Xcode conversation will use.
- A **live** conversation can switch model from the detail pane (same backend). That change is session-only and does not overwrite the Next conversation selection. Timeline rows from the bridge are labeled `(bridge)`; live switches use ids `bridge-live-<n>`.
```

Add this API row after `GET /api/acp-conversations/:bridgePid`:

```markdown
| `PUT /api/acp-conversations/:bridgePid/model` | Live-only model switch (`{ model }`); 409 if ended |
```

Add a manual acceptance step:

```markdown
   5. While a conversation is **live**, open it in the dashboard, change the model select in the detail header. Timeline gains a `session/set_config_option` with id `bridge-live-…`; the list Model column updates; Next conversation's model dropdown is unchanged. Repeat the prompt in Xcode — the new model is used. Ended conversations keep a read-only model label (PUT returns 409).
```

- [ ] **Step 4: Run the full suite**

Run: `bun test`

Expected: PASS. `public/` has no unit tests; eyeball the select markup in `renderAcpDetail` once.

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/index.html public/styles.css README.md
git commit -m "feat: dashboard UI for live in-conversation model switch"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| §1 command file protocol (`acp-commands/<pid>.json`, atomic write) | Task 1 |
| §2 `fs.watch` dir + c2a `stat` fallback | Task 2 |
| §2 `lastSessionId` from new/resume/load | Task 2 |
| §2 inject `bridge-live-<n>`, suppress via `injectedIds` | Task 2 |
| §2 pending command before `session/new` | Task 2 |
| §2 `ts < startedAtMs` ignore | Task 2 |
| §2 same value applied once; `appliedModel` at write time | Task 2 |
| §2 watcher close + unlink on exit | Task 2 |
| §3 PUT live/409/404/400, no route-state write | Task 3 |
| §4 live select in detail, list read-only, SSE focus guard | Task 4 |
| §6 tests listed in spec | Tasks 1–3 |
| §7 out of scope | not implemented |
