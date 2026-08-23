# ACP Observe Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `src/acp-bridge.ts` so Xcode can launch it as an ACP Agent: it transparently forwards stdio JSON-RPC to `opencode acp`, appends events to `data/acp-events.jsonl`, and the existing dashboard shows those events live.

**Architecture:** Xcode spawns the bridge (no HTTP). The bridge spawns one default backend, copies stdin/stdout unchanged, and logs structured NDJSON. The existing Hono dashboard (`bun run start`) tails the JSONL file independently.

**Tech Stack:** Bun, TypeScript, Hono, `bun:test`, existing dashboard HTML/JS.

## Global Constraints

- Phase 1: observe only; no route picker, no JSON-RPC rewrite, no ACP SDK dual-stack.
- Bridge must **not** bind a TCP port.
- Forward bytes unchanged; parse failures still forward the line.
- JSONL: one complete event per line; append only; no rewrite of earlier lines.
- `raw` storage cap: 2MB (`maxRawBytes`); set `truncated: true` when truncated; still forward full line.
- Default backend command is an **absolute** path; do not rely on `PATH` inside the Xcode-spawned process.
- Config path: `ACP_BRIDGE_CONFIG` or `<repoRoot>/acp-bridge.config.json`. Resolve `eventsPath` relative to **repo root** (`import.meta.dir/..`), not `process.cwd()` (Xcode cwd is not the repo).
- Xcode Interpreter: `~/.bun/bin/bun`; Executable: `/path/to/xcode-acp-bridge/src/acp-bridge.ts`.
- One Xcode spawn of the bridge → one backend process.
- Kill backend process group on stdin EOF / SIGTERM; no orphan processes.
- ACP events and HTTP captures stay separate (files and dashboard APIs).

---

## File map

| Path | Responsibility |
|---|---|
| `src/acp/types.ts` | `AcpEvent`, `AcpBridgeConfig` |
| `src/acp/config.ts` | `repoRoot()`, `loadAcpBridgeConfig(path?)` |
| `src/acp/parse.ts` | `parseRpcLine`, `extractSessionHints` |
| `src/acp/event-store.ts` | append / load / clear JSONL |
| `src/acp/run-bridge.ts` | spawn backend, tee stdio, lifecycle |
| `src/acp-bridge.ts` | CLI entry for Xcode |
| `acp-bridge.config.json` | default backend + events path |
| `tests/fixtures/acp-fake-agent.ts` | JSON-RPC fixture backend |
| `tests/acp-parse.test.ts` | line parse + session hints |
| `tests/acp-config.test.ts` | config load + path resolution |
| `tests/acp-event-store.test.ts` | JSONL append/load/clear |
| `tests/acp-bridge.test.ts` | spawn/forward/orphan/truncate |
| `src/acp/tail.ts` | dashboard file tailer |
| `src/dashboard/acp-routes.ts` | `/api/acp-events`, SSE, clear, export |
| `src/index.ts` | mount ACP dashboard routes + start tailer |
| `public/index.html`, `public/app.js`, `public/styles.css` | HTTP / ACP tabs |
| `README.md`, `package.json` | scripts and Xcode fill-in |

---

### Task 1: Types, config loader, JSON-RPC parse

**Files:**
- Create: `src/acp/types.ts`, `src/acp/config.ts`, `src/acp/parse.ts`
- Create: `tests/acp-config.test.ts`, `tests/acp-parse.test.ts`
- Create: `acp-bridge.config.json`

**Interfaces:**
- Consumes: none
- Produces:
  - `export type AcpEventKind = "rpc" | "process_start" | "process_start_error" | "process_end"`
  - `export type AcpDir = "c2a" | "a2c"`
  - `export type AcpEvent` (fields exactly as spec table)
  - `export type AcpBridgeConfig = { defaultBackend: { command: string; args: string[] }; eventsPath: string; maxRawBytes: number }`
  - `export function repoRoot(): string`
  - `export function loadAcpBridgeConfig(configPath?: string): AcpBridgeConfig`
  - `export function extractSessionHints(value: unknown): string[]`
  - `export function parseRpcLine(line: string, maxRawBytes: number): { method: string | null; rpcId: string | number | null; sessionHints: string[]; raw: string; truncated: boolean; parseError: string | null }`

- [ ] **Step 1: Write failing parse tests**

Create `tests/acp-parse.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { extractSessionHints, parseRpcLine } from "../src/acp/parse";

describe("extractSessionHints", () => {
  test("finds sessionId in params and result", () => {
    const hints = extractSessionHints({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "sess-1" },
    });
    expect(hints).toContain("sess-1");
  });

  test("finds session_id nested", () => {
    const hints = extractSessionHints({
      method: "session/prompt",
      params: { session_id: "abc" },
    });
    expect(hints).toContain("abc");
  });

  test("dedupes", () => {
    const hints = extractSessionHints({ sessionId: "x", nested: { sessionId: "x" } });
    expect(hints.filter((h) => h === "x").length).toBe(1);
  });
});

describe("parseRpcLine", () => {
  test("extracts method and id", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    const parsed = parseRpcLine(line, 1024);
    expect(parsed.method).toBe("initialize");
    expect(parsed.rpcId).toBe(0);
    expect(parsed.parseError).toBeNull();
    expect(parsed.truncated).toBe(false);
    expect(parsed.raw).toBe(line);
  });

  test("invalid json sets parseError and keeps raw", () => {
    const parsed = parseRpcLine("{bad", 1024);
    expect(parsed.parseError).not.toBeNull();
    expect(parsed.raw).toBe("{bad");
    expect(parsed.method).toBeNull();
  });

  test("truncates stored raw over maxRawBytes", () => {
    const line = "x".repeat(50);
    const parsed = parseRpcLine(line, 10);
    expect(parsed.truncated).toBe(true);
    expect(parsed.raw.length).toBe(10);
  });
});
```

- [ ] **Step 2: Write failing config test**

Create `tests/acp-config.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAcpBridgeConfig, repoRoot } from "../src/acp/config";

describe("loadAcpBridgeConfig", () => {
  test("resolves eventsPath against repo root not cwd", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-cfg-"));
    const cfgPath = path.join(dir, "cfg.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        defaultBackend: { command: "/bin/echo", args: ["acp"] },
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    const cfg = loadAcpBridgeConfig(cfgPath);
    expect(cfg.defaultBackend.command).toBe("/bin/echo");
    expect(cfg.maxRawBytes).toBe(99);
    expect(cfg.eventsPath).toBe(path.join(repoRoot(), "data/acp-events.jsonl"));
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/acp-parse.test.ts tests/acp-config.test.ts`  
Expected: FAIL (modules not found)

- [ ] **Step 4: Implement types, parse, config, and committed config file**

`src/acp/types.ts`:

```typescript
export type AcpEventKind = "rpc" | "process_start" | "process_start_error" | "process_end";
export type AcpDir = "c2a" | "a2c";

export type AcpEvent = {
  id: string;
  ts: string;
  kind: AcpEventKind;
  bridgePid: number;
  backendPid: number | null;
  dir: AcpDir | null;
  rpcId: string | number | null;
  method: string | null;
  sessionHints: string[];
  raw: string;
  truncated: boolean;
  parseError: string | null;
};

export type AcpBridgeConfig = {
  defaultBackend: { command: string; args: string[] };
  eventsPath: string;
  maxRawBytes: number;
};
```

`src/acp/parse.ts`:

```typescript
function walk(value: unknown, out: Set<string>): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out);
    return;
  }
  if (typeof value !== "object") return;
  const rec = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(rec)) {
    if ((k === "sessionId" || k === "session_id") && typeof v === "string" && v.length > 0) {
      out.add(v);
    }
    walk(v, out);
  }
}

export function extractSessionHints(value: unknown): string[] {
  const out = new Set<string>();
  walk(value, out);
  return [...out];
}

export function parseRpcLine(line: string, maxRawBytes: number): {
  method: string | null;
  rpcId: string | number | null;
  sessionHints: string[];
  raw: string;
  truncated: boolean;
  parseError: string | null;
} {
  const truncated = line.length > maxRawBytes;
  const raw = truncated ? line.slice(0, maxRawBytes) : line;
  try {
    const parsed = JSON.parse(line) as {
      id?: string | number;
      method?: string;
      params?: unknown;
      result?: unknown;
    };
    return {
      method: typeof parsed.method === "string" ? parsed.method : null,
      rpcId: parsed.id ?? null,
      sessionHints: extractSessionHints(parsed),
      raw,
      truncated,
      parseError: null,
    };
  } catch (err) {
    return {
      method: null,
      rpcId: null,
      sessionHints: [],
      raw,
      truncated,
      parseError: err instanceof Error ? err.message : "Invalid JSON",
    };
  }
}
```

`src/acp/config.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import type { AcpBridgeConfig } from "./types";

export function repoRoot(): string {
  return path.resolve(import.meta.dir, "../..");
}

export function defaultConfigPath(): string {
  return process.env.ACP_BRIDGE_CONFIG ?? path.join(repoRoot(), "acp-bridge.config.json");
}

export function loadAcpBridgeConfig(configPath: string = defaultConfigPath()): AcpBridgeConfig {
  const text = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(text) as AcpBridgeConfig;
  const eventsPath = path.isAbsolute(parsed.eventsPath)
    ? parsed.eventsPath
    : path.join(repoRoot(), parsed.eventsPath);
  return { ...parsed, eventsPath };
}
```

`acp-bridge.config.json`:

```json
{
  "defaultBackend": {
    "command": "~/.opencode/bin/opencode",
    "args": ["acp"]
  },
  "eventsPath": "./data/acp-events.jsonl",
  "maxRawBytes": 2097152
}
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/acp-parse.test.ts tests/acp-config.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/acp/types.ts src/acp/config.ts src/acp/parse.ts acp-bridge.config.json tests/acp-parse.test.ts tests/acp-config.test.ts
git commit -m "feat: add ACP bridge config and JSON-RPC line parser"
```

---

### Task 2: AcpEventStore

**Files:**
- Create: `src/acp/event-store.ts`, `tests/acp-event-store.test.ts`

**Interfaces:**
- Consumes: `AcpEvent` from `src/acp/types.ts`
- Produces:
  - `export class AcpEventStore`
  - `constructor(eventsPath: string)`
  - `append(event: AcpEvent): Promise<void>`
  - `load(): Promise<AcpEvent[]>` (read file; missing file → `[]`)
  - `list(): AcpEvent[]` (memory)
  - `clear(): Promise<void>`
  - `subscribe(listener: (event: AcpEvent) => void): () => void`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { AcpEventStore } from "../src/acp/event-store";
import type { AcpEvent } from "../src/acp/types";

const dir = path.join(import.meta.dir, ".tmp-acp-store");
const eventsPath = path.join(dir, "acp-events.jsonl");

function ev(over: Partial<AcpEvent> = {}): AcpEvent {
  return {
    id: "e1",
    ts: new Date().toISOString(),
    kind: "rpc",
    bridgePid: 1,
    backendPid: 2,
    dir: "c2a",
    rpcId: 0,
    method: "initialize",
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

describe("AcpEventStore", () => {
  test("append writes one jsonl line", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev());
    const text = await fs.readFile(eventsPath, "utf8");
    expect(text.trim().split("\n").length).toBe(1);
    expect(store.list()[0].method).toBe("initialize");
  });

  test("load reads existing file", async () => {
    const a = new AcpEventStore(eventsPath);
    await a.append(ev({ id: "a" }));
    const b = new AcpEventStore(eventsPath);
    const loaded = await b.load();
    expect(loaded.length).toBe(1);
    expect(loaded[0].id).toBe("a");
  });

  test("clear deletes file and memory", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev());
    await store.clear();
    expect(store.list().length).toBe(0);
    await expect(fs.readFile(eventsPath, "utf8")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/acp-event-store.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement `src/acp/event-store.ts`**

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import type { AcpEvent } from "./types";

export class AcpEventStore {
  private records: AcpEvent[] = [];
  private listeners: Array<(event: AcpEvent) => void> = [];

  constructor(private readonly eventsPath: string) {}

  async append(event: AcpEvent): Promise<void> {
    this.records.push(event);
    try {
      await fs.mkdir(path.dirname(this.eventsPath), { recursive: true });
      await fs.appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    } catch (err) {
      console.error("AcpEventStore append failed", err);
    }
    for (const listener of this.listeners) listener(event);
  }

  async load(): Promise<AcpEvent[]> {
    try {
      const text = await fs.readFile(this.eventsPath, "utf8");
      this.records = text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AcpEvent);
    } catch {
      this.records = [];
    }
    return this.list();
  }

  list(): AcpEvent[] {
    return [...this.records];
  }

  async clear(): Promise<void> {
    this.records = [];
    try {
      await fs.unlink(this.eventsPath);
    } catch {
      // missing file
    }
  }

  subscribe(listener: (event: AcpEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/acp-event-store.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/acp/event-store.ts tests/acp-event-store.test.ts
git commit -m "feat: add ACP event JSONL store"
```

---

### Task 3: Fake agent fixture + runBridge tee

**Files:**
- Create: `tests/fixtures/acp-fake-agent.ts`, `src/acp/run-bridge.ts`, `tests/acp-bridge.test.ts`

**Interfaces:**
- Consumes: `loadAcpBridgeConfig` is **not** required here; `runBridge` takes explicit options
- Produces:
  - `export type RunBridgeOptions = { backendCommand: string; backendArgs: string[]; eventsPath: string; maxRawBytes: number; stdin: ReadableStream<Uint8Array> | NodeJS.ReadableStream; stdout: NodeJS.WritableStream; bridgePid?: number }`
  - `export async function runBridge(opts: RunBridgeOptions): Promise<{ code: number }>`

Fixture protocol: read NDJSON from stdin. For request `initialize` reply result `{}`. For `session/new` reply `{ sessionId: "sess-fixture" }`. For `session/prompt` write a `session/update` notification then result `{ stopReason: "end_turn" }`. Unknown methods: JSON-RPC error.

- [ ] **Step 1: Create fixture `tests/fixtures/acp-fake-agent.ts`**

```typescript
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

await readLines((line) => {
  let msg: { id?: unknown; method?: string };
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
    reply(msg.id, { sessionId: "sess-fixture" });
    return;
  }
  if (msg.method === "session/prompt") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "sess-fixture", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
      })}\n`,
    );
    reply(msg.id, { stopReason: "end_turn" });
  }
});
```

- [ ] **Step 2: Write failing bridge tests**

```typescript
import { describe, expect, test, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runBridge } from "../src/acp/run-bridge";

const dir = path.join(import.meta.dir, ".tmp-acp-bridge");
const eventsPath = path.join(dir, "acp-events.jsonl");
const fixture = path.join(import.meta.dir, "fixtures/acp-fake-agent.ts");

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("runBridge", () => {
  test("forwards initialize and logs matching rpc ids", async () => {
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

    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } })}\n`,
    );

    await Bun.sleep(200);
    stdin.end();
    await running;

    const out = Buffer.concat(stdoutChunks).toString("utf8");
    expect(out).toContain("protocolVersion");
    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const initC2a = lines.find((e) => e.dir === "c2a" && e.method === "initialize");
    const initA2c = lines.find((e) => e.dir === "a2c" && e.rpcId === 0);
    expect(initC2a).toBeTruthy();
    expect(initA2c).toBeTruthy();
  });

  test("session/new result fills sessionHints", async () => {
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
    const a2c = lines.find((e) => e.dir === "a2c" && e.rpcId === 1);
    expect(a2c.sessionHints).toContain("sess-fixture");
  });

  test("invalid json is forwarded and parseError set", async () => {
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
    stdin.write("{bad\n");
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((e) => e.parseError && e.raw.includes("{bad"))).toBe(true);
  });
});
```

Use `process.execPath` (Bun) so the fixture runs as `bun tests/fixtures/acp-fake-agent.ts`.

- [ ] **Step 3: Run to verify fail**

Run: `bun test tests/acp-bridge.test.ts`  
Expected: FAIL

- [ ] **Step 4: Implement `src/acp/run-bridge.ts`**

Must:

- `Bun.spawn([backendCommand, ...backendArgs], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })`
- Append `process_start` (raw = JSON of command/args) after spawn; on spawn throw, append `process_start_error` and return `{ code: 1 }`
- Line-split both directions; `parseRpcLine`; `store.append` with `kind: "rpc"`; write **original** line + `\n` to the other side (if truncated in store, still write full `line`)
- stderr from backend: `console.error` only
- stdin end / destroy: `proc.kill()` then wait; append `process_end`
- If backend exits first: append `process_end`, end stdout, return its exit code
- `bridgePid`: `opts.bridgePid ?? process.pid`

Keep a small internal `splitLines` helper in this file.

- [ ] **Step 5: Add tests for orphan kill and truncate**

In `tests/acp-bridge.test.ts` add:

```typescript
  test("stdin end kills backend", async () => {
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
    await Bun.sleep(100);
    stdin.end();
    await running;
    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((e) => e.kind === "process_end")).toBe(true);
  });

  test("oversized line truncated in store", async () => {
    await fs.mkdir(dir, { recursive: true });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture],
      eventsPath,
      maxRawBytes: 32,
      stdin,
      stdout,
    });
    const huge = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize", params: { pad: "y".repeat(200) } });
    stdin.write(`${huge}\n`);
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const c2a = lines.find((e) => e.dir === "c2a" && e.method === "initialize");
    expect(c2a.truncated).toBe(true);
    expect(c2a.raw.length).toBe(32);
  });
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/acp-bridge.test.ts`  
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/acp/run-bridge.ts tests/fixtures/acp-fake-agent.ts tests/acp-bridge.test.ts
git commit -m "feat: tee ACP stdio through a spawnable backend"
```

---

### Task 4: `src/acp-bridge.ts` entry

**Files:**
- Create: `src/acp-bridge.ts`
- Modify: `package.json` (add `"acp-bridge": "bun run src/acp-bridge.ts"`)

**Interfaces:**
- Consumes: `loadAcpBridgeConfig`, `runBridge`
- Produces: process entry that uses `process.stdin` / `process.stdout`

- [ ] **Step 1: Implement entry**

```typescript
import { loadAcpBridgeConfig } from "./acp/config";
import { runBridge } from "./acp/run-bridge";

const cfg = loadAcpBridgeConfig();

function onSignal() {
  process.stdin.destroy();
}
process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);

const { code } = await runBridge({
  backendCommand: cfg.defaultBackend.command,
  backendArgs: cfg.defaultBackend.args,
  eventsPath: cfg.eventsPath,
  maxRawBytes: cfg.maxRawBytes,
  stdin: process.stdin,
  stdout: process.stdout,
});
process.exit(code);
```

Ensure `runBridge` treats Node `process.stdin` as a readable that emits `end` (it does). If Bun stdin differs, wrap with `process.stdin.resume()`.

- [ ] **Step 2: Smoke against fixture (not Xcode)**

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}' | \
  ACP_BRIDGE_CONFIG=/tmp/skip bun -e 'console.log("manual")'
```

Instead run a one-off: write a temp config pointing `command` at `process.execPath` and args at the fixture, then:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}' | \
  ACP_BRIDGE_CONFIG=<temp cfg> bun run src/acp-bridge.ts
```

Expected: stdout JSON-RPC result containing `protocolVersion`.

- [ ] **Step 3: Commit**

```bash
git add src/acp-bridge.ts package.json
git commit -m "feat: add acp-bridge CLI entry for Xcode"
```

---

### Task 5: Dashboard tail + ACP APIs

**Files:**
- Create: `src/acp/tail.ts`, `src/dashboard/acp-routes.ts`, `tests/acp-dashboard.test.ts`
- Modify: `src/index.ts`
- Modify: `src/config.ts` to export `acpEventsPath: path.join(dataDir, "acp-events.jsonl")` **or** load from `loadAcpBridgeConfig().eventsPath` so dashboard and bridge share one file. Prefer `loadAcpBridgeConfig().eventsPath` in `src/index.ts`.

**Interfaces:**
- Consumes: `AcpEventStore`, `EventHub` pattern from `src/dashboard/events.ts`
- Produces:
  - `export function startAcpTail(store: AcpEventStore, onEvent: (e: AcpEvent) => void): () => void` — poll file mtime/size every 250ms, `load()` if grown, emit only new ids
  - `export function createAcpDashboardApp(store: AcpEventStore, hub: EventHub): Hono`
  - Routes: `GET /api/acp-events`, `GET /acp-events` (SSE, `Content-Type: text/event-stream` via `c.header` **before** `stream()`), `POST /api/acp-events/clear`, `GET /api/acp-events/export`

Reuse `EventHub` by publishing `{ type: "acp", record: AcpEvent }` **or** stringify the event as `event: acp` / `data: JSON`. Prefer dedicated hub instance: `store.subscribe` + tail both call `hub.publish` with a small adapter. Simplest: copy `EventHub.publish` usage with `event: acp`.

If `EventHub` currently types `CaptureEvent` only, generalize `publish` to accept `{ type: string; record: unknown }` **or** add `publishAcp(event: AcpEvent)` that writes `event: acp\ndata: ...`. Do **not** break existing capture SSE tests. Adding `publishRaw(eventName: string, data: unknown)` on `EventHub` is the smallest change.

- [ ] **Step 1: Extend EventHub**

In `src/dashboard/events.ts` add:

```typescript
  publishNamed(eventName: string, record: unknown): void {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(record)}\n\n`;
    for (const client of [...this.clients]) {
      try {
        client.enqueue(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }
```

Keep existing `publish(event: CaptureEvent)` delegating to `publishNamed(event.type, event.record)`.

- [ ] **Step 2: Implement tail + routes + tests**

Test: append via store in a temp file, `createAcpDashboardApp`, `GET /api/acp-events` returns the event. SSE: subscribe `/acp-events`, append, receive `event: acp` with matching id. `Content-Type` includes `text/event-stream`.

- [ ] **Step 3: Wire `src/index.ts`**

```typescript
import { loadAcpBridgeConfig } from "./acp/config";
import { AcpEventStore } from "./acp/event-store";
import { startAcpTail } from "./acp/tail";
import { createAcpDashboardApp } from "./dashboard/acp-routes";

const acpCfg = loadAcpBridgeConfig();
const acpStore = new AcpEventStore(acpCfg.eventsPath);
await acpStore.load();
const acpHub = new EventHub();
startAcpTail(acpStore, (e) => acpHub.publishNamed("acp", e));
app.route("/", createAcpDashboardApp(acpStore, acpHub));
```

`startAcpTail` must not double-emit events already in memory from `load()`. Track last file size / last id.

- [ ] **Step 4: Run `bun test`**

Expected: all existing tests still pass + new ACP dashboard tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/acp/tail.ts src/dashboard/acp-routes.ts src/dashboard/events.ts src/index.ts tests/acp-dashboard.test.ts
git commit -m "feat: expose ACP events on the observer dashboard API"
```

---

### Task 6: Dashboard UI tabs + README

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/styles.css`, `README.md`

**Interfaces:**
- Consumes: `/api/acp-events`, `/acp-events`, `/api/acp-events/clear`, `/api/acp-events/export`
- Produces: UI tab **HTTP** (existing table) and **ACP** (time, dir, method, sessionHints, bridgePid, kind)

- [ ] **Step 1: HTML**

Add a tab bar above `<main>`: buttons `HTTP` / `ACP`. ACP table thead: Time, Dir, Method, Session, Kind, Bridge PID. tbody `#acp-list`. Detail still `#capture-detail` or `#acp-detail`. Clear/Export must act on the **active** tab (HTTP vs ACP endpoints).

- [ ] **Step 2: JS**

- `EventSource("/acp-events")` listen to `acp`
- `GET /api/acp-events` on load
- Grouping: sort by ts; optional visual separator when `bridgePid` changes
- Highlight `sessionHints` in detail
- Do not break HTTP capture SSE

- [ ] **Step 3: README**

Add section **ACP Agent (Xcode)**:

1. `bun run start` (dashboard)
2. Add ACP Agent:
   - Name: `ACP Bridge`
   - Executable: `/path/to/xcode-acp-bridge/src/acp-bridge.ts`
   - Interpreter: `~/.bun/bin/bun`
   - Arguments: empty
3. New Conversation → ACP Bridge
4. Watch the ACP tab at `http://127.0.0.1:8787/`
5. Manual observation questions from the spec (session id source, cwd/path)

Note: `acp-bridge.config.json` `command` must stay an absolute path to opencode.

Add `package.json` script if not already: `"acp-bridge": "bun run src/acp-bridge.ts"`.

- [ ] **Step 4: Manual smoke**

Dashboard up; `printf` initialize into `bun run src/acp-bridge.ts` with fixture config; ACP tab shows events.

- [ ] **Step 5: Full suite**

Run: `bun test`  
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js public/styles.css README.md package.json
git commit -m "feat: show ACP events in the dashboard and document Xcode setup"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| `acp-bridge.ts` stdio tee, no HTTP bind | 3, 4 |
| Default `opencode acp` absolute command in config | 1, 4 |
| Config / eventsPath vs Xcode cwd | 1 (`repoRoot`) |
| JSONL append, 2MB truncate, parseError still forward | 1, 2, 3 |
| `sessionHints` from `sessionId` / `session_id` | 1, 3 |
| process_start / error / end | 3 |
| Kill backend on stdin EOF | 3 |
| Independent dashboard tail | 5 |
| Separate ACP APIs and UI | 5, 6 |
| Xcode absolute Interpreter/Executable in README | 6 |
| No routing / no SDK / no rewrite | Global constraints |

No TBD placeholders in task steps.

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-08-14-acp-observe-bridge.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks
2. **Inline Execution** — implement in this session with checkpoints

Which approach?
