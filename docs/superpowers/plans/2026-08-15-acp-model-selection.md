# ACP Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard picks route **and model** for the next Xcode conversation; the bridge injects `session/set_config_option` right after `session/new` so the first prompt already runs on the chosen model.

**Architecture:** Selection state `{ route, model? }` lives in `data/acp-route.json` (written by dashboard `PUT /api/acp-route`). Model lists come from an optional per-route `modelsCommand` (e.g. `opencode models`) with fallback to models observed in past `session/new` results. The bridge stays a transparent tee except one documented injection: after forwarding the a2c `session/new` result it writes `session/set_config_option` (id `bridge-<seq>`) into the backend stdin and swallows that response (logged, not forwarded).

**Tech Stack:** Bun, TypeScript, Hono, `bun:test`, existing dashboard HTML/JS.

**Spec:** `docs/superpowers/specs/2026-08-15-acp-model-selection-design.md`

## Global Constraints

- Selection applies to the **next** Xcode spawn only; the live conversation never switches.
- Bridge stays transparent except the documented injection. Injected request ids: `bridge-<seq>`. Injected responses are appended to the event store but **never** written to client stdout.
- Forwarded bytes stay unchanged; parse failures still forward the line.
- JSONL append-only; `raw` cap `maxRawBytes` unchanged.
- `PUT /api/acp-route` is **full replacement**: absent/`null` `model` means no injection.
- Model values are never validated server-side; a bad model fails visibly as an error event in the timeline.
- Committed config uses portable home paths (`~/.opencode/bin/opencode`).
- Injection only triggers on `session/new` (not `session/load` / `session/resume`); one injection per sessionId.
- `model` from state is applied only when the state route is the resolved route (`fallbackReason === null`).

---

## File map

| Path | Responsibility |
|---|---|
| `src/acp/types.ts` | `AcpCommand`, `AcpBackend.modelsCommand?`, `AcpEvent.modelCurrent/modelCount` |
| `src/acp/route-state.ts` | `AcpRouteState { route, model? }` |
| `src/acp/config.ts` | validate optional `modelsCommand` per route |
| `src/acp/parse.ts` | extract `modelCurrent` / `modelCount` from `result.configOptions` |
| `src/acp/run-bridge.ts` | injection logic + new parsed fields on events |
| `src/acp-bridge.ts` | pass `pendingModel` from route state |
| `src/acp/models.ts` | `runModelsCommand`, `observedModelsFromEvents` |
| `src/acp/conversations.ts` | summary `model` field, hydrate new fields |
| `src/dashboard/acp-routes.ts` | `GET /api/acp-models`, extended `PUT /api/acp-route`, `model` in route response |
| `public/index.html`, `public/app.js` | model select, model column, bridge-injected label |
| `tests/fixtures/acp-fake-agent.ts` | configOptions + set_config_option support |
| `tests/fixtures/acp-fake-models.ts` | fake `models` CLI with counter |
| `acp-bridge.config.json`, `README.md` | committed config + docs |

---

### Task 1: Route state carries model; config validates modelsCommand

**Files:**
- Modify: `src/acp/types.ts`, `src/acp/route-state.ts`, `src/acp/config.ts`
- Test: `tests/acp-route-state.test.ts`, `tests/acp-config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export type AcpCommand = { command: string; args: string[] }`
  - `export type AcpBackend = AcpCommand & { modelsCommand?: AcpCommand }`
  - `export type AcpRouteState = { route: string; model?: string }`
  - `loadAcpRouteState` keeps a non-empty string `model`; `writeAcpRouteState` unchanged signature

- [ ] **Step 1: Write failing route-state tests**

Append to `tests/acp-route-state.test.ts` inside `describe("loadAcpRouteState")`:

```typescript
  test("keeps model when it is a non-empty string", () => {
    fs.writeFileSync(filePath, JSON.stringify({ route: "other", model: "m-x" }));
    expect(loadAcpRouteState(filePath)).toEqual({ route: "other", model: "m-x" });
  });

  test("drops model when empty or non-string", () => {
    fs.writeFileSync(filePath, JSON.stringify({ route: "other", model: "" }));
    expect(loadAcpRouteState(filePath)).toEqual({ route: "other" });
    fs.writeFileSync(filePath, JSON.stringify({ route: "other", model: 42 }));
    expect(loadAcpRouteState(filePath)).toEqual({ route: "other" });
  });
```

And inside `describe("writeAcpRouteState")`:

```typescript
  test("round-trips model", () => {
    writeAcpRouteState(filePath, { route: "opencode", model: "m-y" });
    expect(loadAcpRouteState(filePath)).toEqual({ route: "opencode", model: "m-y" });
  });
```

- [ ] **Step 2: Write failing config tests**

Append to `tests/acp-config.test.ts` inside `describe("loadAcpBridgeConfig")`:

```typescript
  test("loads optional modelsCommand per route", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        routes: {
          opencode: {
            command: "/bin/echo",
            args: ["acp"],
            modelsCommand: { command: "/bin/echo", args: ["models"] },
          },
        },
        defaultRoute: "opencode",
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.routes.opencode.modelsCommand).toEqual({ command: "/bin/echo", args: ["models"] });
  });

  test("throws naming the route key when modelsCommand is invalid", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {
            opencode: { command: "/bin/echo", args: ["acp"], modelsCommand: { command: "/bin/echo" } },
          },
          defaultRoute: "opencode",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 99,
        }),
      ),
    ).toThrow(/routes\.opencode/);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/acp-route-state.test.ts tests/acp-config.test.ts`
Expected: FAIL (new assertions fail; `modelsCommand` not on type)

- [ ] **Step 4: Implement types, route-state, config**

`src/acp/types.ts` — replace the `AcpBackend` line:

```typescript
export type AcpCommand = { command: string; args: string[] };
export type AcpBackend = AcpCommand & { modelsCommand?: AcpCommand };
```

`src/acp/route-state.ts` — replace type and loader (writer unchanged):

```typescript
export type AcpRouteState = { route: string; model?: string };

export function loadAcpRouteState(filePath: string): AcpRouteState | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed.route !== "string" || parsed.route === "") {
      return null;
    }
    const state: AcpRouteState = { route: parsed.route };
    if (typeof parsed.model === "string" && parsed.model.length > 0) {
      state.model = parsed.model;
    }
    return state;
  } catch {
    return null;
  }
}
```

`src/acp/config.ts` — generalize the backend check (rename `isBackend` usage; keep the same error messages):

```typescript
function isCommand(value: unknown): value is AcpCommand {
  if (typeof value !== "object" || value === null) return false;
  const cmd = value as Record<string, unknown>;
  return typeof cmd.command === "string" && Array.isArray(cmd.args);
}

function isBackend(value: unknown): value is AcpBackend {
  if (!isCommand(value)) return false;
  const modelsCommand = (value as AcpBackend).modelsCommand;
  return modelsCommand === undefined || isCommand(modelsCommand);
}
```

Add `AcpCommand` to the type import: `import type { AcpBackend, AcpBridgeConfig, AcpCommand } from "./types";`

- [ ] **Step 5: Run tests**

Run: `bun test tests/acp-route-state.test.ts tests/acp-config.test.ts`
Expected: PASS (all old + new)

- [ ] **Step 6: Commit**

```bash
git add src/acp/types.ts src/acp/route-state.ts src/acp/config.ts tests/acp-route-state.test.ts tests/acp-config.test.ts
git commit -m "feat: carry model selection in route state and validate modelsCommand"
```

---

### Task 2: Bridge injects session/set_config_option after session/new

**Files:**
- Modify: `tests/fixtures/acp-fake-agent.ts`, `src/acp/run-bridge.ts`, `src/acp-bridge.ts`
- Test: `tests/acp-bridge.test.ts`

**Interfaces:**
- Consumes: `AcpRouteState.model` from Task 1
- Produces: `RunBridgeOptions.pendingModel?: string | null`; injected RPC ids match `/^bridge-\d+$/`

- [ ] **Step 1: Extend the fake agent fixture (needed by failing tests)**

Replace the whole of `tests/fixtures/acp-fake-agent.ts`:

```typescript
let currentModel = "fixture/model-a";

function configOptions() {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: [
        { value: "fixture/model-a", name: "Model A" },
        { value: "fixture/model-b", name: "Model B" },
      ],
    },
  ];
}

async function readLines(onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) onLine(line);
    }
  }
}

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id: unknown, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message } })}\n`,
  );
}

await readLines((line) => {
  let msg: { id?: unknown; method?: string; params?: { configId?: unknown; value?: unknown } };
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
  if (msg.method === "session/set_config_option") {
    const value = msg.params?.value;
    if (
      msg.params?.configId === "model" &&
      (value === "fixture/model-a" || value === "fixture/model-b")
    ) {
      currentModel = value;
      reply(msg.id, { configOptions: configOptions() });
    } else {
      replyError(msg.id, "unknown config option or value");
    }
    return;
  }
  if (msg.method === "session/prompt") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-fixture",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        },
      })}\n`,
    );
    reply(msg.id, { stopReason: "end_turn" });
  }
});
```

- [ ] **Step 2: Write failing injection tests**

Append inside `describe("runBridge")` in `tests/acp-bridge.test.ts`:

```typescript
  test("injects set_config_option after session/new and before prompt", async () => {
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
      pendingModel: "fixture/model-b",
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
    const newIdx = lines.findIndex((e) => e.dir === "c2a" && e.method === "session/new");
    const injectIdx = lines.findIndex((e) => e.dir === "c2a" && e.method === "session/set_config_option");
    const promptIdx = lines.findIndex((e) => e.dir === "c2a" && e.method === "session/prompt");
    expect(injectIdx).toBeGreaterThan(newIdx);
    expect(promptIdx).toBeGreaterThan(injectIdx);
    expect(String(lines[injectIdx].rpcId)).toMatch(/^bridge-/);
    expect(JSON.parse(lines[injectIdx].raw).params.value).toBe("fixture/model-b");
    expect(JSON.parse(lines[injectIdx].raw).params.sessionId).toBe("sess-fixture");
  });

  test("injected response is logged but not forwarded to client", async () => {
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
      pendingModel: "fixture/model-b",
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    stdin.end();
    await running;
    const out = Buffer.concat(stdoutChunks).toString("utf8");
    expect(out).toContain("sess-fixture");
    expect(out).not.toContain("bridge-");
    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const a2c = lines.find((e) => e.dir === "a2c" && String(e.rpcId).startsWith("bridge-"));
    expect(a2c).toBeTruthy();
    expect(JSON.parse(a2c.raw).result.configOptions[0].currentValue).toBe("fixture/model-b");
  });

  test("no injection when pendingModel is null", async () => {
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
    stdin.end();
    await running;
    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((e) => e.method === "session/set_config_option")).toBe(false);
  });

  test("injection error is logged and session continues", async () => {
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
      pendingModel: "fixture/unknown",
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
    const errEvent = lines.find((e) => e.dir === "a2c" && String(e.rpcId).startsWith("bridge-"));
    expect(errEvent).toBeTruthy();
    expect(errEvent.raw).toContain("unknown config option or value");
    const out = Buffer.concat(stdoutChunks).toString("utf8");
    expect(out).toContain("end_turn");
    expect(out).not.toContain("bridge-");
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/acp-bridge.test.ts`
Expected: FAIL on the 4 new tests (no injection happens yet)

- [ ] **Step 4: Implement injection in `src/acp/run-bridge.ts`**

Add to `RunBridgeOptions`:

```typescript
  pendingModel?: string | null;
```

Add a module-level helper next to `splitLines`:

```typescript
function sessionIdFromNewResultRaw(line: string): string | null {
  try {
    const msg: unknown = JSON.parse(line);
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return null;
    const result = (msg as Record<string, unknown>).result;
    if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
    const sessionId = (result as Record<string, unknown>).sessionId;
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
  } catch {
    return null;
  }
}
```

Inside `runBridge`, after `let finished = false;` add:

```typescript
  const pendingModel = opts.pendingModel ?? null;
  const sessionNewIds = new Set<string | number>();
  const injectedIds = new Set<string>();
  const injectedSessions = new Set<string>();
  let injectSeq = 0;
```

Change `logRpc` to return the parsed line (append `return parsed;` and its return type becomes the `parseRpcLine` result):

```typescript
  const logRpc = async (dir: AcpDir, line: string) => {
    const parsed = parseRpcLine(line, opts.maxRawBytes);
    await store.append(
      makeEvent({
        kind: "rpc",
        dir,
        rpcId: parsed.rpcId,
        method: parsed.method,
        sessionHints: parsed.sessionHints,
        raw: parsed.raw,
        truncated: parsed.truncated,
        parseError: parsed.parseError,
        cwd: parsed.cwd,
        mcpXcodeSessionId: parsed.mcpXcodeSessionId,
        sessionUpdate: parsed.sessionUpdate,
        toolName: parsed.toolName,
      }),
    );
    return parsed;
  };
```

Replace the two splitter definitions:

```typescript
  const c2aSplitter = splitLines(async (line) => {
    const parsed = await logRpc("c2a", line);
    if (pendingModel !== null && parsed.method === "session/new" && parsed.rpcId !== null) {
      sessionNewIds.add(parsed.rpcId);
    }
    proc.stdin.write(`${line}\n`);
  });

  const a2cSplitter = splitLines(async (line) => {
    const parsed = await logRpc("a2c", line);
    if (parsed.rpcId !== null && injectedIds.has(String(parsed.rpcId))) {
      return; // response to a bridge-injected request: logged, never forwarded
    }
    opts.stdout.write(`${line}\n`);
    if (pendingModel === null || parsed.rpcId === null || !sessionNewIds.has(parsed.rpcId)) return;
    sessionNewIds.delete(parsed.rpcId);
    const sessionId = sessionIdFromNewResultRaw(line);
    if (sessionId === null || injectedSessions.has(sessionId)) return;
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
  });
```

- [ ] **Step 5: Wire the entry `src/acp-bridge.ts`**

Replace the `runBridge` call:

```typescript
const { code } = await runBridge({
  backendCommand: resolved.backend.command,
  backendArgs: resolved.backend.args,
  eventsPath: cfg.eventsPath,
  maxRawBytes: cfg.maxRawBytes,
  stdin: process.stdin,
  stdout: process.stdout,
  route: resolved.name,
  pendingModel: resolved.fallbackReason === null ? (state?.model ?? null) : null,
});
```

- [ ] **Step 6: Add CLI end-to-end test**

Append inside `describe("runBridge")` in `tests/acp-bridge.test.ts`:

```typescript
  test("CLI injects model from route state", async () => {
    await fs.mkdir(dir, { recursive: true });
    const cfgPath = path.join(dir, "cfg.json");
    const statePath = path.join(dir, "acp-route.json");
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        routes: { fixture: { command: process.execPath, args: [fixture] } },
        defaultRoute: "fixture",
        eventsPath,
        routeStatePath: statePath,
        maxRawBytes: 2 * 1024 * 1024,
      }),
    );
    await fs.writeFile(statePath, JSON.stringify({ route: "fixture", model: "fixture/model-b" }));
    const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/acp-bridge.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ACP_BRIDGE_CONFIG: cfgPath },
    });
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`,
    );
    await Bun.sleep(300);
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).not.toContain("bridge-");
    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const inject = lines.find((e) => e.dir === "c2a" && e.method === "session/set_config_option");
    expect(inject).toBeTruthy();
    expect(JSON.parse(inject.raw).params.value).toBe("fixture/model-b");
  });
```

- [ ] **Step 7: Run tests**

Run: `bun test tests/acp-bridge.test.ts`
Expected: PASS (all old + new)

- [ ] **Step 8: Commit**

```bash
git add src/acp/run-bridge.ts src/acp-bridge.ts tests/fixtures/acp-fake-agent.ts tests/acp-bridge.test.ts
git commit -m "feat: inject session/set_config_option after session/new"
```

---

### Task 3: Observe configOptions (modelCurrent / modelCount)

**Files:**
- Modify: `src/acp/types.ts`, `src/acp/parse.ts`, `src/acp/run-bridge.ts`, `src/acp/conversations.ts`
- Test: `tests/acp-parse.test.ts`, `tests/acp-conversations.test.ts`

**Interfaces:**
- Consumes: `logRpc` returns `parseRpcLine` result (Task 2)
- Produces:
  - `AcpEvent.modelCurrent?: string | null`, `AcpEvent.modelCount?: number | null`
  - `parseRpcLine` result gains `modelCurrent: string | null; modelCount: number | null`
  - `ConversationSummary.model: string | null` (last observed `modelCurrent`)

- [ ] **Step 1: Write failing parse tests**

Append a new describe to `tests/acp-parse.test.ts`:

```typescript
describe("parseRpcLine configOptions", () => {
  test("session/new result exposes modelCurrent and modelCount", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        sessionId: "s1",
        configOptions: [
          {
            id: "model",
            category: "model",
            type: "select",
            currentValue: "m-a",
            options: [{ value: "m-a" }, { value: "m-b" }],
          },
          { id: "mode", category: "mode", type: "select", currentValue: "build", options: [] },
        ],
      },
    });
    const parsed = parseRpcLine(line, 1024);
    expect(parsed.modelCurrent).toBe("m-a");
    expect(parsed.modelCount).toBe(2);
  });

  test("falls back to id model when category is missing", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        configOptions: [{ id: "model", type: "select", currentValue: "m-x", options: [{ value: "m-x" }] }],
      },
    });
    expect(parseRpcLine(line, 1024).modelCurrent).toBe("m-x");
  });

  test("no configOptions gives nulls", () => {
    const parsed = parseRpcLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), 1024);
    expect(parsed.modelCurrent).toBeNull();
    expect(parsed.modelCount).toBeNull();
  });
});
```

- [ ] **Step 2: Write failing conversations test**

Append inside `describe("summarizeConversations")` in `tests/acp-conversations.test.ts`:

```typescript
  test("summary model is the last observed modelCurrent", () => {
    const events = [
      ev({ id: "1", ts: "t1", kind: "rpc", dir: "a2c", modelCurrent: "m-a", raw: "{}" }),
      ev({ id: "2", ts: "t2", kind: "rpc", dir: "a2c", modelCurrent: "m-b", raw: "{}" }),
      ev({ id: "3", ts: "t3", kind: "rpc", dir: "c2a", raw: "{}" }),
    ];
    const rows = summarizeConversations(events);
    expect(rows[0].model).toBe("m-b");
  });

  test("hydrates modelCurrent from raw when the field is missing", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        sessionId: "s",
        configOptions: [{ id: "model", category: "model", currentValue: "m-x", options: [] }],
      },
    });
    const rows = summarizeConversations([ev({ id: "1", ts: "t1", kind: "rpc", dir: "a2c", raw })]);
    expect(rows[0].model).toBe("m-x");
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/acp-parse.test.ts tests/acp-conversations.test.ts`
Expected: FAIL (fields do not exist)

- [ ] **Step 4: Implement**

`src/acp/types.ts` — extend `AcpEvent`:

```typescript
  toolName?: string | null;
  modelCurrent?: string | null;
  modelCount?: number | null;
```

`src/acp/parse.ts` — add the helper after `findMcpXcodeSessionId`:

```typescript
function modelFromConfigOptions(result: unknown): { current: string | null; count: number | null } {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { current: null, count: null };
  }
  const options = (result as Record<string, unknown>).configOptions;
  if (!Array.isArray(options)) return { current: null, count: null };
  const modelOption = options.find((o) => {
    if (o === null || typeof o !== "object" || Array.isArray(o)) return false;
    const rec = o as Record<string, unknown>;
    return rec.category === "model" || (rec.category == null && rec.id === "model");
  }) as Record<string, unknown> | undefined;
  if (!modelOption) return { current: null, count: null };
  const current =
    typeof modelOption.currentValue === "string" && modelOption.currentValue.length > 0
      ? modelOption.currentValue
      : null;
  const count = Array.isArray(modelOption.options) ? modelOption.options.length : null;
  return { current, count };
}
```

Extend `RpcMeta`:

```typescript
export type RpcMeta = {
  cwd: string | null;
  mcpXcodeSessionId: string | null;
  sessionUpdate: string | null;
  toolName: string | null;
  sessionHints: string[];
  modelCurrent: string | null;
  modelCount: number | null;
};
```

In `extractRpcMeta`, add locals `let modelCurrent: string | null = null; let modelCount: number | null = null;`, then inside the existing top-level `if` block (where `rec.params` is read) add:

```typescript
    const model = modelFromConfigOptions(rec.result);
    modelCurrent = model.current;
    modelCount = model.count;
```

and extend the return:

```typescript
  return { cwd, mcpXcodeSessionId, sessionUpdate, toolName, sessionHints, modelCurrent, modelCount };
```

`parseRpcLine` return type annotation gains `modelCurrent: string | null; modelCount: number | null`; the success path already spreads `extractRpcMeta`; the failure path adds `modelCurrent: null, modelCount: null`.

`src/acp/run-bridge.ts` — `makeEvent` defaults gain two lines after `toolName: null,`:

```typescript
    modelCurrent: null,
    modelCount: null,
```

and `logRpc` passes them:

```typescript
        toolName: parsed.toolName,
        modelCurrent: parsed.modelCurrent,
        modelCount: parsed.modelCount,
```

`src/acp/conversations.ts`:
- `ConversationSummary` gains `model: string | null;`
- `hydrateEvent` return gains:

```typescript
      modelCurrent: event.modelCurrent ?? meta.modelCurrent,
      modelCount: event.modelCount ?? meta.modelCount,
```

- add helper after `firstNonNull`:

```typescript
function lastNonNull<T>(events: AcpEvent[], pick: (event: AcpEvent) => T | null | undefined): T | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const value = pick(events[i]!);
    if (value != null) return value;
  }
  return null;
}
```

- `summarizeGroup` return gains (place after `route`):

```typescript
    model: lastNonNull(events, (event) => event.modelCurrent),
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/acp-parse.test.ts tests/acp-conversations.test.ts tests/acp-bridge.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/acp/types.ts src/acp/parse.ts src/acp/run-bridge.ts src/acp/conversations.ts tests/acp-parse.test.ts tests/acp-conversations.test.ts
git commit -m "feat: observe configOptions model state on ACP events"
```

---

### Task 4: Dashboard API — models endpoint + model in route selection

**Files:**
- Create: `src/acp/models.ts`, `tests/fixtures/acp-fake-models.ts`, `tests/acp-models.test.ts`
- Modify: `src/dashboard/acp-routes.ts`, `tests/acp-dashboard.test.ts`

**Interfaces:**
- Consumes: `AcpBackend.modelsCommand` (Task 1), `AcpRouteState.model` (Task 1)
- Produces:
  - `export async function runModelsCommand(cmd: AcpCommand, timeoutMs?: number): Promise<string[]>`
  - `export function observedModelsFromEvents(events: AcpEvent[], route: string): string[]`
  - `GET /api/acp-models?route=<name>[&refresh=1]` → `{ route, models: string[], source: "command" | "observed" | "none", warning?: string, current: string | null }`; unknown route → 400
  - `PUT /api/acp-route` accepts `{ route: string, model?: string | null }`; GET response gains `model: string | null`

- [ ] **Step 1: Create fake models fixture**

Create `tests/fixtures/acp-fake-models.ts`:

```typescript
import fs from "node:fs";

const counterPath = process.argv[2]!;
let n = 0;
try {
  n = Number(fs.readFileSync(counterPath, "utf8"));
} catch {
  // first run
}
n += 1;
fs.writeFileSync(counterPath, String(n));
console.log(`model-${n}`);
```

- [ ] **Step 2: Write failing models API tests**

Create `tests/acp-models.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { AcpEventStore } from "../src/acp/event-store";
import type { AcpBridgeConfig, AcpEvent } from "../src/acp/types";
import { EventHub } from "../src/dashboard/events";
import { createAcpDashboardApp } from "../src/dashboard/acp-routes";

const dir = path.join(import.meta.dir, ".tmp-acp-models");
const eventsPath = path.join(dir, "acp-events.jsonl");
const modelsFixture = path.join(import.meta.dir, "fixtures/acp-fake-models.ts");
const counterPath = path.join(dir, "counter.txt");

function testConfig(): AcpBridgeConfig {
  return {
    routes: {
      opencode: {
        command: "/bin/echo",
        args: ["acp"],
        modelsCommand: { command: process.execPath, args: [modelsFixture, counterPath] },
      },
      broken: {
        command: "/bin/true",
        args: [],
        modelsCommand: { command: "/bin/false", args: [] },
      },
      plain: { command: "/bin/true", args: [] },
    },
    defaultRoute: "opencode",
    defaultBackend: { command: "/bin/echo", args: ["acp"] },
    eventsPath,
    routeStatePath: path.join(dir, "acp-route.json"),
    maxRawBytes: 99,
  };
}

function acpApp(store: AcpEventStore) {
  return createAcpDashboardApp(store, new EventHub(), { config: testConfig() });
}

function sessionNewResultRaw(models: string[]): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      sessionId: "s1",
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: models[0],
          options: models.map((value) => ({ value, name: value })),
        },
      ],
    },
  });
}

function ev(over: Partial<AcpEvent> = {}): AcpEvent {
  return {
    id: "e1",
    ts: new Date().toISOString(),
    kind: "rpc",
    bridgePid: 1,
    backendPid: 2,
    dir: "a2c",
    rpcId: 1,
    method: null,
    sessionHints: [],
    raw: "{}",
    truncated: false,
    parseError: null,
    ...over,
  };
}

beforeEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("GET /api/acp-models", () => {
  test("runs modelsCommand and caches per route", async () => {
    const app = acpApp(new AcpEventStore(eventsPath));
    const first = await (await app.request("http://127.0.0.1/api/acp-models?route=opencode")).json();
    expect(first.models).toEqual(["model-1"]);
    expect(first.source).toBe("command");
    const second = await (await app.request("http://127.0.0.1/api/acp-models?route=opencode")).json();
    expect(second.models).toEqual(["model-1"]); // cached, command ran once
    const refreshed = await (
      await app.request("http://127.0.0.1/api/acp-models?route=opencode&refresh=1")
    ).json();
    expect(refreshed.models).toEqual(["model-2"]);
  });

  test("unknown route returns 400", async () => {
    const app = acpApp(new AcpEventStore(eventsPath));
    const res = await app.request("http://127.0.0.1/api/acp-models?route=nope");
    expect(res.status).toBe(400);
  });

  test("falls back to observed configOptions when no modelsCommand", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "obs-1", route: "plain", raw: sessionNewResultRaw(["m-x", "m-y"]) }));
    const app = acpApp(store);
    const body = await (await app.request("http://127.0.0.1/api/acp-models?route=plain")).json();
    expect(body.models).toEqual(["m-x", "m-y"]);
    expect(body.source).toBe("observed");
  });

  test("observed ignores other routes", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "obs-2", route: "opencode", raw: sessionNewResultRaw(["m-other"]) }));
    const app = acpApp(store);
    const body = await (await app.request("http://127.0.0.1/api/acp-models?route=plain")).json();
    expect(body.models).toEqual([]);
    expect(body.source).toBe("none");
  });

  test("command failure warns and falls back to observed", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "obs-3", route: "broken", raw: sessionNewResultRaw(["m-cached"]) }));
    const app = acpApp(store);
    const body = await (await app.request("http://127.0.0.1/api/acp-models?route=broken")).json();
    expect(body.source).toBe("observed");
    expect(body.models).toEqual(["m-cached"]);
    expect(body.warning).toContain("modelsCommand failed");
  });

  test("current reflects route state model", async () => {
    const app = acpApp(new AcpEventStore(eventsPath));
    await app.request("http://127.0.0.1/api/acp-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "plain", model: "m-x" }),
    });
    const body = await (await app.request("http://127.0.0.1/api/acp-models?route=plain")).json();
    expect(body.current).toBe("m-x");
  });
});
```

- [ ] **Step 3: Write failing PUT-model tests**

Append to `tests/acp-dashboard.test.ts` inside `describe("acp dashboard api")`:

```typescript
  test("PUT /api/acp-route persists model and GET returns it", async () => {
    const store = new AcpEventStore(eventsPath);
    const app = acpApp(store);
    const put = await app.request("http://127.0.0.1/api/acp-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "other", model: "m-1" }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).model).toBe("m-1");
    const get = await (await app.request("http://127.0.0.1/api/acp-route")).json();
    expect(get.route).toBe("other");
    expect(get.model).toBe("m-1");
  });

  test("PUT without model clears the selection", async () => {
    const store = new AcpEventStore(eventsPath);
    const app = acpApp(store);
    await app.request("http://127.0.0.1/api/acp-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "other", model: "m-1" }),
    });
    await app.request("http://127.0.0.1/api/acp-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "other" }),
    });
    const get = await (await app.request("http://127.0.0.1/api/acp-route")).json();
    expect(get.model).toBeNull();
  });

  test("PUT with non-string model returns 400", async () => {
    const store = new AcpEventStore(eventsPath);
    const app = acpApp(store);
    const put = await app.request("http://127.0.0.1/api/acp-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "other", model: 42 }),
    });
    expect(put.status).toBe(400);
  });
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test tests/acp-models.test.ts tests/acp-dashboard.test.ts`
Expected: FAIL (endpoint/model handling missing)

- [ ] **Step 5: Implement `src/acp/models.ts`**

```typescript
import type { AcpCommand, AcpEvent } from "./types";

export async function runModelsCommand(cmd: AcpCommand, timeoutMs = 5000): Promise<string[]> {
  const proc = Bun.spawn([cmd.command, ...cmd.args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) throw new Error(`exit ${code}`);
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } finally {
    clearTimeout(timer);
  }
}

function modelsFromConfigOptionsRaw(raw: string): string[] | null {
  try {
    const msg: unknown = JSON.parse(raw);
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return null;
    const result = (msg as Record<string, unknown>).result;
    if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
    const options = (result as Record<string, unknown>).configOptions;
    if (!Array.isArray(options)) return null;
    const modelOption = options.find((o) => {
      if (o === null || typeof o !== "object" || Array.isArray(o)) return false;
      const rec = o as Record<string, unknown>;
      return rec.category === "model" || (rec.category == null && rec.id === "model");
    }) as Record<string, unknown> | undefined;
    if (!modelOption || !Array.isArray(modelOption.options)) return null;
    return modelOption.options
      .map((o) =>
        o !== null && typeof o === "object" && typeof (o as Record<string, unknown>).value === "string"
          ? ((o as Record<string, unknown>).value as string)
          : null,
      )
      .filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return null;
  }
}

export function observedModelsFromEvents(events: AcpEvent[], route: string): string[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind !== "rpc" || event.dir !== "a2c" || event.raw.length === 0) continue;
    if (event.route != null && event.route !== route) continue;
    const models = modelsFromConfigOptionsRaw(event.raw);
    if (models !== null && models.length > 0) return models;
  }
  return [];
}
```

- [ ] **Step 6: Wire `src/dashboard/acp-routes.ts`**

Add imports:

```typescript
import { observedModelsFromEvents, runModelsCommand } from "../acp/models";
import type { AcpRouteState } from "../acp/route-state";
```

Replace `routeResponse`:

```typescript
function routeResponse(config: AcpBridgeConfig): {
  route: string;
  defaultRoute: string;
  routes: string[];
  source: "state" | "default";
  model: string | null;
} {
  const state = loadAcpRouteState(config.routeStatePath);
  const resolved = resolveRoute(config, state);
  const model = resolved.fallbackReason === null && state ? (state.model ?? null) : null;
  return {
    route: resolved.name,
    defaultRoute: config.defaultRoute,
    routes: Object.keys(config.routes),
    source: resolved.fallbackReason === null ? "state" : "default",
    model,
  };
}
```

Replace the `PUT /api/acp-route` handler:

```typescript
  app.put("/api/acp-route", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "unknown route" }, 400);
    }
    const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const route = rec.route;
    if (typeof route !== "string" || !(route in config.routes)) {
      return c.json({ error: "unknown route" }, 400);
    }
    const model = rec.model;
    if (model !== undefined && model !== null && typeof model !== "string") {
      return c.json({ error: "invalid model" }, 400);
    }
    const state: AcpRouteState = { route };
    if (typeof model === "string" && model.length > 0) {
      state.model = model;
    }
    writeAcpRouteState(config.routeStatePath, state);
    return c.json({ ...routeResponse(config), source: "state" as const });
  });
```

Add the models endpoint (before the conversations routes). The cache lives in the app closure so each app instance (dashboard process) caches per route:

```typescript
  const modelsCache = new Map<string, string[]>();

  app.get("/api/acp-models", async (c) => {
    const route = c.req.query("route") ?? "";
    const refresh = c.req.query("refresh") === "1";
    if (!(route in config.routes)) {
      return c.json({ error: "unknown route" }, 400);
    }
    const backend = config.routes[route]!;
    const state = loadAcpRouteState(config.routeStatePath);
    const current = state && state.route === route && typeof state.model === "string" ? state.model : null;

    let models: string[] | null = null;
    let source: "command" | "observed" | "none" = "none";
    let warning: string | undefined;

    if (backend.modelsCommand) {
      const cached = modelsCache.get(route);
      if (cached && !refresh) {
        models = cached;
        source = "command";
      } else {
        try {
          models = await runModelsCommand(backend.modelsCommand);
          modelsCache.set(route, models);
          source = "command";
        } catch (err) {
          warning = `modelsCommand failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
    if (models === null) {
      const observed = observedModelsFromEvents(store.list(), route);
      if (observed.length > 0) {
        models = observed;
        source = "observed";
      } else {
        models = [];
      }
    }
    return c.json({ route, models, source, warning, current });
  });
```

- [ ] **Step 7: Run tests**

Run: `bun test tests/acp-models.test.ts tests/acp-dashboard.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/acp/models.ts src/dashboard/acp-routes.ts tests/fixtures/acp-fake-models.ts tests/acp-models.test.ts tests/acp-dashboard.test.ts
git commit -m "feat: expose model listing and model selection on the ACP dashboard API"
```

---

### Task 5: Dashboard UI — model select, model column, bridge-injected label

**Files:**
- Modify: `public/index.html`, `public/app.js`

**Interfaces:**
- Consumes: `GET /api/acp-route` (`model`), `GET /api/acp-models` (`models`, `source`, `warning`, `current`), `PUT /api/acp-route { route, model }`, conversation summaries `model` field

- [ ] **Step 1: HTML — extend the route bar and table header**

In `public/index.html` replace the route-bar div:

```html
        <div class="route-bar">
          <label for="acp-next-route">Next conversation</label>
          <select id="acp-next-route"></select>
          <label for="acp-next-model">Model</label>
          <select id="acp-next-model"></select>
          <span id="acp-model-status" class="hint"></span>
          <span class="hint">Applies to the next Xcode conversation. The current one is unchanged.</span>
        </div>
```

Add a Model column after Route in the ACP table thead:

```html
              <th>Route</th>
              <th>Model</th>
```

- [ ] **Step 2: JS — element refs and loaders**

In `public/app.js` after the existing `const acpNextRouteEl = ...` line add:

```javascript
const acpNextModelEl = document.getElementById("acp-next-model");
const acpModelStatusEl = document.getElementById("acp-model-status");
```

Replace `loadAcpRoute`:

```javascript
async function loadAcpModels() {
  const route = acpNextRouteEl.value;
  if (!route) return;
  const data = await fetch(`/api/acp-models?route=${encodeURIComponent(route)}`).then((r) => r.json());
  const models = data.models ?? [];
  acpNextModelEl.innerHTML = [
    `<option value="">(backend default)</option>`,
    ...models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`),
  ].join("");
  acpNextModelEl.value = data.current ?? "";
  acpModelStatusEl.textContent = data.warning
    ? `model list: ${data.warning}`
    : data.source === "observed"
      ? "model list from last observed session"
      : "";
}

async function loadAcpRoute() {
  acpRoute = await fetch("/api/acp-route").then((r) => r.json());
  acpNextRouteEl.innerHTML = (acpRoute.routes ?? [])
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    .join("");
  acpNextRouteEl.value = acpRoute.route;
  await loadAcpModels();
}
```

Add the model change listener next to the existing route change listener:

```javascript
acpNextModelEl.addEventListener("change", async () => {
  await fetch("/api/acp-route", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      route: acpNextRouteEl.value,
      model: acpNextModelEl.value || null,
    }),
  });
  await loadAcpRoute();
});
```

- [ ] **Step 3: JS — model column and bridge-injected label**

In `conversationRowHtml`, add the model cell after the route cell:

```javascript
        <td>${dash(c.route)}</td>
        <td>${dash(c.model)}</td>
```

In `renderAcpDetail`'s header block, add after the route paragraph:

```javascript
      <p><strong>model:</strong> ${dash(d.model)}</p>
```

Replace `timelineBodyLabel`'s rpc branch to flag bridge-injected lines:

```javascript
  if (item.type === "rpc") {
    const injected = String(item.rpcId ?? "").startsWith("bridge-");
    const base =
      item.method === "rpc" || !item.method
        ? item.dir === "a2c"
          ? "result"
          : "rpc"
        : item.method;
    return injected ? `${base} (bridge)` : base;
  }
```

- [ ] **Step 4: Manual smoke**

Run: `bun run start`
1. ACP tab: route `opencode`; Model select lists the 17 opencode models (source command).
2. Pick a model, e.g. `deepseek/deepseek-chat`; reload page → selection persists.
3. Xcode New Conversation → ACP Bridge → send a prompt.
4. Timeline shows `session/set_config_option (bridge)`; conversation row Model column shows `deepseek/deepseek-chat`.

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: pick ACP model from the dashboard"
```

---

### Task 6: Committed config + README + full suite

**Files:**
- Modify: `acp-bridge.config.json`, `README.md`

**Interfaces:**
- Consumes: everything above

- [ ] **Step 1: Update `acp-bridge.config.json`**

```json
{
  "routes": {
    "opencode": {
      "command": "~/.opencode/bin/opencode",
      "args": ["acp"],
      "modelsCommand": {
        "command": "~/.opencode/bin/opencode",
        "args": ["models"]
      }
    }
  },
  "defaultRoute": "opencode",
  "eventsPath": "./data/acp-events.jsonl",
  "routeStatePath": "./data/acp-route.json",
  "maxRawBytes": 2097152
}
```

- [ ] **Step 2: README**

In the **ACP Agent (Xcode)** section, replace the bullet "Next conversation dropdown chooses which `routes` entry…" with:

```markdown
- **Next conversation** dropdowns choose the `routes` entry **and the model** the **next** Xcode conversation will use. The live conversation does not switch.
- The model list comes from the route's optional `modelsCommand` (e.g. `opencode models`); without it the dashboard falls back to models observed in past `session/new` results. `GET /api/acp-models?route=<name>&refresh=1` bypasses the in-memory cache.
- When a model is selected, the bridge injects one `session/set_config_option` (id `bridge-<n>`) right after `session/new`; the response is logged but not forwarded to Xcode. Timeline rows from the bridge are labeled `(bridge)`.
- To add a backend, edit `acp-bridge.config.json`:
```

In the API table, add a row after `PUT /api/acp-route`:

```markdown
| `GET /api/acp-models?route=<name>` | Model list for a route (`source`: command / observed / none) |
```

And update the `PUT /api/acp-route` row to "Set next-spawn route + model (`{ route, model? }`, full replacement)".

- [ ] **Step 3: Full suite + real-backend smoke**

Run: `bun test`
Expected: all PASS

Manual:
1. `bun run start`; ACP tab → pick model `deepseek/deepseek-chat` (or any non-default).
2. Xcode New Conversation → ACP Bridge → prompt; reply works.
3. Timeline shows `session/set_config_option (bridge)`; conversation Model column shows the pick.
4. Pick a garbage model id (type via `curl -X PUT localhost:8787/api/acp-route -H 'Content-Type: application/json' -d '{"route":"opencode","model":"bogus/x"}'`); new conversation → timeline shows the backend's error event; conversation still works on the default model.

- [ ] **Step 4: Commit**

```bash
git add acp-bridge.config.json README.md
git commit -m "docs: document ACP model selection and modelsCommand"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| `AcpRouteState { route, model? }`; PUT full replacement | 1, 4 |
| `modelsCommand` per route + committed config | 1, 6 |
| `GET /api/acp-models` with cache / refresh / observed fallback / warning | 4 |
| Injection after session/new, `bridge-<seq>` ids, swallow response, once per session | 2 |
| Model only when state route is resolved route | 2 (entry) |
| Observation: `modelCurrent` / `modelCount`, conversation `model`, timeline `(bridge)` label | 3, 5 |
| Error handling: command failure warning, injection error visible, no server-side validation | 4, 2 |
| UI: model select + status, model column, detail model | 5 |
| Tests for every new behavior | 1–4 |
| README | 6 |

No TBD placeholders in task steps. Type check: `pendingModel` (Task 2) ↔ entry (Task 2); `runModelsCommand` / `observedModelsFromEvents` (Task 4) used by routes; `modelCurrent/modelCount` (Task 3) consumed by conversations and UI (Task 5). Fixture `configOptions` (Task 2) shape matches parse expectations (Task 3).

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-08-15-acp-model-selection.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks
2. **Inline Execution** — implement in this session with checkpoints

Which approach?
