# Xcode Observer Bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a local observation stub so Xcode Intelligence can call `/v1/models` and `/v1/chat/completions`, every request is captured to JSONL, and a browser dashboard shows live capture history with path hints.

**Architecture:** One Bun process binds `127.0.0.1:8080`, serves OpenAI-compatible provider routes for Xcode, persists finalized captures to `./data/captures.jsonl`, and serves a minimal HTML dashboard plus JSON/SSE APIs. No OpenCode, no tool execution, stub responses only.

**Tech Stack:** Bun, TypeScript, Hono, `bun:test`, plain HTML/CSS/JS (no Vite).

## Global Constraints

- Bind to `127.0.0.1` only; default port `8080`; do not auto-pick another port on conflict.
- Phase 1: capture + stub only; no `opencode serve`, no ACP, no tool forwarding.
- Stub never fabricates `tool_calls` even when request includes `tools`.
- JSONL: one complete record per line on finalize; no rewriting prior lines.
- Body storage cap: 2MB; set `bodyTruncated` when truncated.
- Fixed model id for listing: `xcode-observer`.
- Invalid JSON → `400` OpenAI-style error + capture with `parseError`.
- Missing/weird `messages` → still `200` text stub so Xcode keeps probing.

---

## File map

| Path | Responsibility |
|---|---|
| `package.json` | Scripts, deps (`hono`), Bun test config |
| `tsconfig.json` | Strict TS for `src/` + `tests/` |
| `.gitignore` | `data/`, `node_modules/` |
| `src/index.ts` | Boot server, wire routes, fail loudly on port conflict |
| `src/config.ts` | `PORT`, `HOST`, `DATA_DIR`, `MAX_BODY_BYTES` |
| `src/types.ts` | `CaptureRecord`, `CaptureSummary`, event payloads |
| `src/capture/path-hints.ts` | Regex scan for paths / `.xcodeproj` / `file://` |
| `src/capture/summarize.ts` | Parse body JSON → `summary` + `parseError` |
| `src/capture/store.ts` | Pending/finalize, memory list, JSONL append, clear |
| `src/capture/mask-headers.ts` | Mask `Authorization` for dashboard API |
| `src/stub/responder.ts` | Non-stream + SSE stub builders |
| `src/provider/models.ts` | `GET /v1/models` response body |
| `src/provider/handle-request.ts` | Shared capture pipeline for provider routes |
| `src/dashboard/events.ts` | In-process SSE broadcaster |
| `src/dashboard/routes.ts` | `/api/captures`, `/events`, clear, export |
| `public/index.html` | Dashboard shell |
| `public/app.js` | List, detail, SSE client, actions |
| `public/styles.css` | Minimal layout |
| `tests/path-hints.test.ts` | Path hint regex tests |
| `tests/summarize.test.ts` | Summary extraction tests |
| `tests/store.test.ts` | CaptureStore persistence tests |
| `tests/stub-responder.test.ts` | Stub shape tests |
| `tests/provider.test.ts` | HTTP integration tests |
| `README.md` | Install, run, Xcode setup, manual acceptance |

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/index.ts` (minimal hello), `README.md` (stub)

**Interfaces:**
- Consumes: none
- Produces: `npm run dev` / `bun run dev` starts a server on `127.0.0.1:8080`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "xcode-chat-provider",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "hono": "^4.9.6"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.9.2"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
data/
.DS_Store
```

- [ ] **Step 4: Minimal `src/index.ts`**

```typescript
import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 8080);

Bun.serve({
  hostname: host,
  port,
  fetch: app.fetch,
});

console.log(`xcode-acp-bridge listening on http://${host}:${port}`);
```

- [ ] **Step 5: Install Bun (if missing) and dependencies**

Run:
```bash
# if needed: curl -fsSL https://bun.sh/install | bash
bun install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 6: Smoke start**

Run: `bun run start` (background), then:
```bash
curl -s http://127.0.0.1:8080/health
```
Expected: `{"ok":true}`

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore src/index.ts README.md bun.lock
git commit -m "chore: scaffold Bun + Hono project"
```

---

### Task 2: Types and config

**Files:**
- Create: `src/types.ts`, `src/config.ts`
- Modify: `src/index.ts` (import config)

**Interfaces:**
- Consumes: none
- Produces:
  - `export const config` from `src/config.ts` with `{ host, port, dataDir, capturesPath, maxBodyBytes }`
  - `export type CaptureRecord`, `CaptureSummary`, `CaptureEvent` from `src/types.ts`

- [ ] **Step 1: Write failing test for config defaults**

Create `tests/config.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { config } from "../src/config";

describe("config", () => {
  test("defaults", () => {
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8080);
    expect(config.maxBodyBytes).toBe(2 * 1024 * 1024);
    expect(config.capturesPath.endsWith("captures.jsonl")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL — module `../src/config` not found

- [ ] **Step 3: Implement `src/types.ts`**

```typescript
export type CaptureSummary = {
  model?: string;
  stream?: boolean;
  messageCount?: number;
  hasTools?: boolean;
  toolCount?: number;
};

export type CaptureRecord = {
  id: string;
  ts: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  rawBody: string;
  bodyTruncated: boolean;
  parseError: string | null;
  summary: CaptureSummary;
  pathHints: string[];
  response: unknown;
  statusCode: number;
  durationMs: number;
  clientAborted: boolean;
  pending?: boolean;
};

export type CaptureEvent =
  | { type: "pending"; record: CaptureRecord }
  | { type: "final"; record: CaptureRecord };
```

- [ ] **Step 4: Implement `src/config.ts`**

```typescript
import path from "node:path";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 8080);
const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const capturesPath = path.join(dataDir, "captures.jsonl");
const maxBodyBytes = 2 * 1024 * 1024;

export const config = { host, port, dataDir, capturesPath, maxBodyBytes };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/config.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: add shared types and config"
```

---

### Task 3: Path hints

**Files:**
- Create: `src/capture/path-hints.ts`, `tests/path-hints.test.ts`

**Interfaces:**
- Consumes: none
- Produces: `export function extractPathHints(text: string): string[]`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { extractPathHints } from "../src/capture/path-hints";

describe("extractPathHints", () => {
  test("finds posix path and xcodeproj", () => {
    const text =
      "project at /Users/dev/MyApp/MyApp.xcodeproj and file:///tmp/foo";
    const hints = extractPathHints(text);
    expect(hints).toContain("/Users/dev/MyApp/MyApp.xcodeproj");
    expect(hints.some((h) => h.startsWith("file://"))).toBe(true);
  });

  test("finds xcworkspace", () => {
    const hints = extractPathHints("/Users/a/Repo/App.xcworkspace");
    expect(hints).toContain("/Users/a/Repo/App.xcworkspace");
  });

  test("dedupes matches", () => {
    const path = "/Users/a/Repo/App.xcodeproj";
    const hints = extractPathHints(`${path} ${path}`);
    expect(hints.filter((h) => h === path).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/path-hints.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/capture/path-hints.ts`**

```typescript
const PATTERNS = [
  /file:\/\/[^\s"'<>]+/g,
  /\/Users\/[^\s"'<>]+?\.xcodeproj/g,
  /\/Users\/[^\s"'<>]+?\.xcworkspace/g,
  /\/Users\/[^\s"'<>]+/g,
];

export function extractPathHints(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      found.add(match[0]);
    }
  }
  return [...found];
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/path-hints.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture/path-hints.ts tests/path-hints.test.ts
git commit -m "feat: extract path hints from capture text"
```

---

### Task 4: Request summarizer

**Files:**
- Create: `src/capture/summarize.ts`, `tests/summarize.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - `export function summarizeBody(rawBody: string): { summary: CaptureSummary; parseError: string | null; parsed: unknown | null }`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { summarizeBody } from "../src/capture/summarize";

describe("summarizeBody", () => {
  test("parses chat completion body", () => {
    const raw = JSON.stringify({
      model: "xcode-observer",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
    const { summary, parseError, parsed } = summarizeBody(raw);
    expect(parseError).toBeNull();
    expect(parsed).not.toBeNull();
    expect(summary.model).toBe("xcode-observer");
    expect(summary.stream).toBe(true);
    expect(summary.messageCount).toBe(1);
    expect(summary.hasTools).toBe(true);
    expect(summary.toolCount).toBe(1);
  });

  test("invalid json sets parseError", () => {
    const { parseError, parsed } = summarizeBody("{bad");
    expect(parseError).not.toBeNull();
    expect(parsed).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/summarize.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/capture/summarize.ts`**

```typescript
import type { CaptureSummary } from "../types";

type ChatBody = {
  model?: string;
  stream?: boolean;
  messages?: unknown[];
  tools?: unknown[];
};

export function summarizeBody(rawBody: string): {
  summary: CaptureSummary;
  parseError: string | null;
  parsed: unknown | null;
} {
  if (!rawBody) {
    return { summary: {}, parseError: null, parsed: null };
  }
  try {
    const parsed = JSON.parse(rawBody) as ChatBody;
    const tools = parsed.tools ?? [];
    return {
      summary: {
        model: parsed.model,
        stream: parsed.stream ?? false,
        messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : undefined,
        hasTools: tools.length > 0,
        toolCount: tools.length,
      },
      parseError: null,
      parsed,
    };
  } catch (err) {
    return {
      summary: {},
      parseError: err instanceof Error ? err.message : "Invalid JSON",
      parsed: null,
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/summarize.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture/summarize.ts tests/summarize.test.ts
git commit -m "feat: summarize OpenAI chat completion bodies"
```

---

### Task 5: CaptureStore

**Files:**
- Create: `src/capture/store.ts`, `tests/store.test.ts`

**Interfaces:**
- Consumes: `config`, `CaptureRecord`, `CaptureEvent`
- Produces:
  - `export class CaptureStore`
  - `createPending(record: CaptureRecord): void`
  - `finalize(record: CaptureRecord): Promise<void>`
  - `list(): CaptureRecord[]`
  - `clear(): Promise<void>`
  - `subscribe(listener: (event: CaptureEvent) => void): () => void`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { CaptureStore } from "../src/capture/store";

const testDir = path.join(import.meta.dir, ".tmp-store");
const capturesPath = path.join(testDir, "captures.jsonl");

function baseRecord(): CaptureRecord {
  return {
    id: "rec-1",
    ts: new Date().toISOString(),
    method: "POST",
    path: "/v1/chat/completions",
    headers: {},
    rawBody: "{}",
    bodyTruncated: false,
    parseError: null,
    summary: {},
    pathHints: [],
    response: null,
    statusCode: 0,
    durationMs: 0,
    clientAborted: false,
    pending: true,
  };
}

beforeEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
  await fs.mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("CaptureStore", () => {
  test("finalize appends one jsonl line", async () => {
    const store = new CaptureStore(capturesPath);
    const pending = baseRecord();
    store.createPending(pending);
    const final = { ...pending, pending: false, statusCode: 200, durationMs: 5, response: { ok: true } };
    await store.finalize(final);
    const text = await fs.readFile(capturesPath, "utf8");
    expect(text.trim().split("\n").length).toBe(1);
    expect(store.list().length).toBe(1);
    expect(store.list()[0].statusCode).toBe(200);
  });

  test("clear resets memory and file", async () => {
    const store = new CaptureStore(capturesPath);
    const final = { ...baseRecord(), pending: false, statusCode: 200, durationMs: 1, response: {} };
    await store.finalize(final);
    await store.clear();
    expect(store.list().length).toBe(0);
    await expect(fs.readFile(capturesPath, "utf8")).rejects.toThrow();
  });

  test("subscribe receives pending and final", async () => {
    const store = new CaptureStore(capturesPath);
    const events: string[] = [];
    store.subscribe((e) => events.push(e.type));
    store.createPending(baseRecord());
    await store.finalize({ ...baseRecord(), pending: false, statusCode: 200, durationMs: 1, response: {} });
    expect(events).toEqual(["pending", "final"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/store.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/capture/store.ts`**

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import type { CaptureEvent, CaptureRecord } from "../types";

export class CaptureStore {
  private records: CaptureRecord[] = [];
  private listeners: Array<(event: CaptureEvent) => void> = [];

  constructor(private readonly capturesPath: string) {}

  createPending(record: CaptureRecord): void {
    const pending = { ...record, pending: true };
    this.records.push(pending);
    this.emit({ type: "pending", record: pending });
  }

  async finalize(record: CaptureRecord): Promise<void> {
    const final = { ...record, pending: false };
    const idx = this.records.findIndex((r) => r.id === final.id);
    if (idx >= 0) this.records[idx] = final;
    else this.records.push(final);

    await fs.mkdir(path.dirname(this.capturesPath), { recursive: true });
    await fs.appendFile(this.capturesPath, `${JSON.stringify(final)}\n`, "utf8");
    this.emit({ type: "final", record: final });
  }

  list(): CaptureRecord[] {
    return [...this.records];
  }

  async clear(): Promise<void> {
    this.records = [];
    try {
      await fs.unlink(this.capturesPath);
    } catch {
      // file may not exist
    }
  }

  subscribe(listener: (event: CaptureEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: CaptureEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture/store.ts tests/store.test.ts
git commit -m "feat: add CaptureStore with JSONL persistence"
```

---

### Task 6: StubResponder

**Files:**
- Create: `src/stub/responder.ts`, `tests/stub-responder.test.ts`

**Interfaces:**
- Consumes: `CaptureSummary` (optional model id)
- Produces:
  - `export const STUB_MODEL_ID = "xcode-observer"`
  - `export function buildModelsResponse(): unknown`
  - `export function buildCompletionStub(model?: string): unknown`
  - `export function buildStreamChunks(model?: string): string[]` — raw SSE lines including `data: [DONE]`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import {
  STUB_MODEL_ID,
  buildCompletionStub,
  buildModelsResponse,
  buildStreamChunks,
} from "../src/stub/responder";

describe("StubResponder", () => {
  test("models includes xcode-observer", () => {
    const body = buildModelsResponse() as { data: Array<{ id: string }> };
    expect(body.data.some((m) => m.id === STUB_MODEL_ID)).toBe(true);
  });

  test("completion stub is OpenAI-shaped and has no tool_calls", () => {
    const body = buildCompletionStub("xcode-observer") as {
      object: string;
      choices: Array<{ message: { content: string; tool_calls?: unknown } }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toContain("Captured");
    expect(body.choices[0].message.tool_calls).toBeUndefined();
  });

  test("stream chunks include content and finish_reason", () => {
    const chunks = buildStreamChunks("xcode-observer");
    const joined = chunks.join("\n");
    expect(joined).toContain("chat.completion.chunk");
    expect(joined).toContain("delta");
    expect(joined).toContain("finish_reason");
    expect(joined).toContain("[DONE]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/stub-responder.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/stub/responder.ts`**

```typescript
export const STUB_MODEL_ID = "xcode-observer";
const STUB_TEXT = "Captured by xcode-acp-bridge (observation stub).";

function completionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
}

export function buildModelsResponse(): unknown {
  return {
    object: "list",
    data: [
      {
        id: STUB_MODEL_ID,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "xcode-chat-provider",
      },
    ],
  };
}

export function buildCompletionStub(model?: string): unknown {
  return {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model ?? STUB_MODEL_ID,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: STUB_TEXT },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function buildStreamChunks(model?: string): string[] {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const m = model ?? STUB_MODEL_ID;
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null) =>
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: m,
      choices: [{ index: 0, delta, finish_reason }],
    });

  return [
    `data: ${chunk({ role: "assistant", content: "" }, null)}`,
    `data: ${chunk({ content: STUB_TEXT }, null)}`,
    `data: ${chunk({}, "stop")}`,
    "data: [DONE]",
  ];
}

export function buildErrorResponse(message: string, type = "invalid_request_error"): unknown {
  return { error: { message, type } };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/stub-responder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/stub/responder.ts tests/stub-responder.test.ts
git commit -m "feat: add OpenAI-compatible stub responder"
```

---

### Task 7: Provider request pipeline + routes

**Files:**
- Create: `src/capture/mask-headers.ts`, `src/provider/handle-request.ts`, `src/provider/models.ts`
- Modify: `src/index.ts` (mount provider + dashboard routes)

**Interfaces:**
- Consumes: `CaptureStore`, `summarizeBody`, `extractPathHints`, `StubResponder`, `config`
- Produces:
  - `export function createProviderApp(store: CaptureStore): Hono`
  - Routes: `GET /v1/models`, `POST /v1/chat/completions`

- [ ] **Step 1: Write failing HTTP tests**

Create `tests/provider.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { CaptureStore } from "../src/capture/store";
import { createProviderApp } from "../src/provider/handle-request";
import { STUB_MODEL_ID } from "../src/stub/responder";

const testDir = path.join(import.meta.dir, ".tmp-provider");
const capturesPath = path.join(testDir, "captures.jsonl");

beforeEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("provider routes", () => {
  test("GET /v1/models", async () => {
    const app = createProviderApp(new CaptureStore(capturesPath));
    const res = await app.request("http://127.0.0.1/v1/models");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.some((m: { id: string }) => m.id === STUB_MODEL_ID)).toBe(true);
  });

  test("POST /v1/chat/completions non-stream", async () => {
    const app = createProviderApp(new CaptureStore(capturesPath));
    const res = await app.request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: STUB_MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    const jsonl = await fs.readFile(capturesPath, "utf8");
    expect(jsonl.includes("/v1/chat/completions")).toBe(true);
  });

  test("POST invalid json returns 400 and capture", async () => {
    const app = createProviderApp(new CaptureStore(capturesPath));
    const res = await app.request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    expect(res.status).toBe(400);
    const jsonl = await fs.readFile(capturesPath, "utf8");
    const record = JSON.parse(jsonl.trim());
    expect(record.parseError).not.toBeNull();
  });

  test("POST stream returns SSE", async () => {
    const app = createProviderApp(new CaptureStore(capturesPath));
    const res = await app.request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: STUB_MODEL_ID,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("[DONE]");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/provider.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/capture/mask-headers.ts`**

```typescript
export function maskHeadersForDisplay(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...headers };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === "authorization") {
      out[key] = "***";
    }
  }
  return out;
}
```

- [ ] **Step 4: Implement `src/provider/handle-request.ts`**

```typescript
import { Hono } from "hono";
import { streamText } from "hono/streaming";
import { extractPathHints } from "../capture/path-hints";
import { summarizeBody } from "../capture/summarize";
import type { CaptureStore } from "../capture/store";
import { config } from "../config";
import type { CaptureRecord } from "../types";
import {
  buildCompletionStub,
  buildErrorResponse,
  buildModelsResponse,
  buildStreamChunks,
} from "../stub/responder";

function normalizeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function truncateBody(raw: string): { rawBody: string; bodyTruncated: boolean } {
  if (raw.length <= config.maxBodyBytes) {
    return { rawBody: raw, bodyTruncated: false };
  }
  return { rawBody: raw.slice(0, config.maxBodyBytes), bodyTruncated: true };
}

export function createProviderApp(store: CaptureStore): Hono {
  const app = new Hono();

  app.get("/v1/models", async (c) => {
    const started = Date.now();
    const headers = normalizeHeaders(c.req.raw.headers);
    const id = crypto.randomUUID();
    const pending: CaptureRecord = {
      id,
      ts: new Date().toISOString(),
      method: "GET",
      path: "/v1/models",
      headers,
      rawBody: "",
      bodyTruncated: false,
      parseError: null,
      summary: {},
      pathHints: extractPathHints(JSON.stringify(headers)),
      response: null,
      statusCode: 0,
      durationMs: 0,
      clientAborted: false,
      pending: true,
    };
    store.createPending(pending);
    const response = buildModelsResponse();
    const final: CaptureRecord = {
      ...pending,
      response,
      statusCode: 200,
      durationMs: Date.now() - started,
      pending: false,
    };
    await store.finalize(final);
    return c.json(response);
  });

  app.post("/v1/chat/completions", async (c) => {
    const started = Date.now();
    const headers = normalizeHeaders(c.req.raw.headers);
    const raw = await c.req.text();
    const { rawBody, bodyTruncated } = truncateBody(raw);
    const { summary, parseError, parsed } = summarizeBody(rawBody);
    const pathHints = extractPathHints(`${JSON.stringify(headers)}\n${rawBody}`);
    const id = crypto.randomUUID();

    const pending: CaptureRecord = {
      id,
      ts: new Date().toISOString(),
      method: "POST",
      path: "/v1/chat/completions",
      headers,
      rawBody,
      bodyTruncated,
      parseError,
      summary,
      pathHints,
      response: null,
      statusCode: 0,
      durationMs: 0,
      clientAborted: false,
      pending: true,
    };
    store.createPending(pending);

    if (parseError) {
      const response = buildErrorResponse(parseError);
      await store.finalize({
        ...pending,
        response,
        statusCode: 400,
        durationMs: Date.now() - started,
        pending: false,
      });
      return c.json(response, 400);
    }

    const body = (parsed ?? {}) as { model?: string; stream?: boolean };
    const model = body.model;

    if (body.stream) {
      const chunks = buildStreamChunks(model);
      return streamText(c, async (stream) => {
        let clientAborted = false;
        try {
          for (const line of chunks) {
            await stream.write(`${line}\n\n`);
          }
        } catch {
          clientAborted = true;
        }
        const response = { stream: true, chunks };
        await store.finalize({
          ...pending,
          response,
          statusCode: 200,
          durationMs: Date.now() - started,
          clientAborted,
          pending: false,
        });
      }, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const response = buildCompletionStub(model);
    await store.finalize({
      ...pending,
      response,
      statusCode: 200,
      durationMs: Date.now() - started,
      pending: false,
    });
    return c.json(response);
  });

  return app;
}
```

- [ ] **Step 5: Run provider tests**

Run: `bun test tests/provider.test.ts`
Expected: PASS

- [ ] **Step 6: Wire `src/index.ts`**

```typescript
import { Hono } from "hono";
import { CaptureStore } from "./capture/store";
import { config } from "./config";
import { createProviderApp } from "./provider/handle-request";

const store = new CaptureStore(config.capturesPath);
const app = new Hono();

app.route("/", createProviderApp(store));
app.get("/health", (c) => c.json({ ok: true }));

try {
  Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: app.fetch,
  });
  console.log(`xcode-acp-bridge listening on http://${config.host}:${config.port}`);
} catch (err) {
  console.error(`Failed to bind ${config.host}:${config.port}. Is the port in use?`);
  console.error(err);
  process.exit(1);
}
```

- [ ] **Step 7: Commit**

```bash
git add src/capture/mask-headers.ts src/provider/handle-request.ts tests/provider.test.ts src/index.ts
git commit -m "feat: add provider routes with capture pipeline"
```

---

### Task 8: Dashboard API

**Files:**
- Create: `src/dashboard/events.ts`, `src/dashboard/routes.ts`
- Modify: `src/index.ts` (mount dashboard routes + static files)

**Interfaces:**
- Consumes: `CaptureStore`, `maskHeadersForDisplay`
- Produces:
  - `export function createDashboardApp(store: CaptureStore): Hono`
  - `GET /api/captures` — masked headers
  - `GET /events` — SSE `pending` / `final`
  - `POST /api/captures/clear`
  - `GET /api/captures/export` — JSON array download

- [ ] **Step 1: Write failing tests**

Add to `tests/provider.test.ts` or create `tests/dashboard.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { CaptureStore } from "../src/capture/store";
import { createDashboardApp } from "../src/dashboard/routes";
import path from "node:path";

describe("dashboard api", () => {
  test("lists captures with masked authorization", async () => {
    const capturesPath = path.join(import.meta.dir, ".tmp-dash", "captures.jsonl");
    const store = new CaptureStore(capturesPath);
    await store.finalize({
      id: "1",
      ts: new Date().toISOString(),
      method: "GET",
      path: "/v1/models",
      headers: { authorization: "Bearer secret" },
      rawBody: "",
      bodyTruncated: false,
      parseError: null,
      summary: {},
      pathHints: [],
      response: {},
      statusCode: 200,
      durationMs: 1,
      clientAborted: false,
    });
    const app = createDashboardApp(store);
    const res = await app.request("http://127.0.0.1/api/captures");
    const body = await res.json();
    expect(body[0].headers.authorization).toBe("***");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/dashboard.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/dashboard/events.ts`**

```typescript
import type { CaptureEvent } from "../types";

export class EventHub {
  private clients = new Set<ReadableStreamDefaultController<string>>();

  publish(event: CaptureEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.record)}\n\n`;
    for (const client of this.clients) {
      client.enqueue(payload);
    }
  }

  subscribe(): ReadableStream<string> {
    return new ReadableStream<string>({
      start: (controller) => {
        this.clients.add(controller);
      },
      cancel: (controller) => {
        this.clients.delete(controller as ReadableStreamDefaultController<string>);
      },
    });
  }
}
```

- [ ] **Step 4: Implement `src/dashboard/routes.ts`**

```typescript
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { maskHeadersForDisplay } from "../capture/mask-headers";
import type { CaptureStore } from "../capture/store";
import type { CaptureRecord } from "../types";
import { EventHub } from "./events";

function forDisplay(record: CaptureRecord): CaptureRecord {
  return { ...record, headers: maskHeadersForDisplay(record.headers) };
}

export function createDashboardApp(store: CaptureStore, hub: EventHub): Hono {
  const app = new Hono();

  store.subscribe((event) => hub.publish(event));

  app.get("/api/captures", (c) => {
    return c.json(store.list().map(forDisplay));
  });

  app.get("/events", (c) => {
    return stream(c, async (s) => {
      const body = hub.subscribe();
      const reader = body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          await s.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  app.post("/api/captures/clear", async (c) => {
    await store.clear();
    return c.json({ ok: true });
  });

  app.get("/api/captures/export", (c) => {
    const json = JSON.stringify(store.list(), null, 2);
    return new Response(json, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": "attachment; filename=captures-export.json",
      },
    });
  });

  return app;
}
```

- [ ] **Step 5: Update `src/index.ts` to mount dashboard + static**

```typescript
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { CaptureStore } from "./capture/store";
import { config } from "./config";
import { EventHub } from "./dashboard/events";
import { createDashboardApp } from "./dashboard/routes";
import { createProviderApp } from "./provider/handle-request";

const store = new CaptureStore(config.capturesPath);
const hub = new EventHub();
const app = new Hono();

app.route("/", createProviderApp(store));
app.route("/", createDashboardApp(store, hub));
app.get("/health", (c) => c.json({ ok: true }));
app.use("/", serveStatic({ root: "./public" }));

try {
  Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
  console.log(`xcode-acp-bridge listening on http://${config.host}:${config.port}`);
} catch (err) {
  console.error(`Failed to bind ${config.host}:${config.port}. Is the port in use?`);
  console.error(err);
  process.exit(1);
}
```

- [ ] **Step 6: Run dashboard test**

Run: `bun test tests/dashboard.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/events.ts src/dashboard/routes.ts tests/dashboard.test.ts src/index.ts
git commit -m "feat: add dashboard API and SSE events"
```

---

### Task 9: Dashboard UI

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/styles.css`

**Interfaces:**
- Consumes: `/api/captures`, `/events`, `/api/captures/clear`, `/api/captures/export`
- Produces: Browser dashboard at `/`

- [ ] **Step 1: Create `public/styles.css`** (minimal two-column layout, monospace detail, `.path-hint` highlight)

- [ ] **Step 2: Create `public/index.html`**

Structure:
- Header: title + buttons `Clear`, `Export`
- Left: `#capture-list` table (time, method, path, model, stream, tools, status, ms)
- Right: `#capture-detail` with sections Headers / Body / Path hints / Response

- [ ] **Step 3: Create `public/app.js`**

```javascript
const listEl = document.getElementById("capture-list");
const detailEl = document.getElementById("capture-detail");
let records = [];
let selectedId = null;

function fmtTime(ts) {
  return new Date(ts).toLocaleString();
}

function renderList() {
  listEl.innerHTML = records
    .map((r) => {
      const pending = r.pending ? "pending" : r.statusCode;
      return `<tr data-id="${r.id}" class="${r.id === selectedId ? "selected" : ""}">
        <td>${fmtTime(r.ts)}</td>
        <td>${r.method}</td>
        <td>${r.path}</td>
        <td>${r.summary?.model ?? ""}</td>
        <td>${r.summary?.stream ? "yes" : ""}</td>
        <td>${r.summary?.hasTools ? "yes" : ""}</td>
        <td>${pending}</td>
        <td>${r.durationMs ?? ""}</td>
      </tr>`;
    })
    .join("");
  listEl.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => select(tr.dataset.id));
  });
}

function highlightPaths(text, hints) {
  let html = text;
  for (const hint of hints) {
    html = html.split(hint).join(`<mark class="path-hint">${hint}</mark>`);
  }
  return html;
}

function select(id) {
  selectedId = id;
  const r = records.find((x) => x.id === id);
  if (!r) return;
  renderList();
  detailEl.innerHTML = `
    <h3>Capture ${r.id}</h3>
    <p><strong>Path hints:</strong> ${r.pathHints?.join(", ") || "none"}</p>
    <h4>Headers</h4><pre>${JSON.stringify(r.headers, null, 2)}</pre>
    <h4>Body</h4><pre>${highlightPaths(r.rawBody, r.pathHints)}</pre>
    <h4>Response</h4><pre>${JSON.stringify(r.response, null, 2)}</pre>
  `;
}

async function load() {
  records = await fetch("/api/captures").then((r) => r.json());
  renderList();
}

document.getElementById("btn-clear").addEventListener("click", async () => {
  await fetch("/api/captures/clear", { method: "POST" });
  records = [];
  selectedId = null;
  detailEl.innerHTML = "";
  renderList();
});

document.getElementById("btn-export").addEventListener("click", () => {
  window.location.href = "/api/captures/export";
});

const es = new EventSource("/events");
es.addEventListener("pending", (e) => {
  const record = JSON.parse(e.data);
  records = [record, ...records.filter((r) => r.id !== record.id)];
  renderList();
});
es.addEventListener("final", (e) => {
  const record = JSON.parse(e.data);
  records = records.map((r) => (r.id === record.id ? record : r));
  if (!records.some((r) => r.id === record.id)) records.unshift(record);
  if (selectedId === record.id) select(record.id);
  renderList();
});

load();
```

- [ ] **Step 4: Manual smoke**

Run: `bun run start`
Open: `http://127.0.0.1:8080`
Run:
```bash
curl -s http://127.0.0.1:8080/v1/models
```
Refresh dashboard — capture row appears.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat: add observation dashboard UI"
```

---

### Task 10: Full test suite + README

**Files:**
- Modify: `README.md`
- Modify: `tests/` (add tools + pathHints integration assertions if missing)

- [ ] **Step 1: Add provider test for tools + pathHints**

```typescript
test("tools request sets hasTools and pathHints from xcodeproj", async () => {
  const app = createProviderApp(new CaptureStore(capturesPath));
  const path = "/Users/dev/App/App.xcodeproj";
  const res = await app.request("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "xcode-observer",
      messages: [{ role: "user", content: `open ${path}` }],
      tools: [{ type: "function", function: { name: "read_file", parameters: {} } }],
    }),
  });
  expect(res.status).toBe(200);
  const jsonl = await fs.readFile(capturesPath, "utf8");
  const record = JSON.parse(jsonl.trim());
  expect(record.summary.hasTools).toBe(true);
  expect(record.pathHints).toContain(path);
  expect(record.response.choices?.[0]?.message?.tool_calls).toBeUndefined();
});
```

- [ ] **Step 2: Run full suite**

Run: `bun test`
Expected: all PASS

- [ ] **Step 3: Write `README.md`**

Include:
- Prereq: Bun
- `bun install && bun run start`
- Xcode: Settings → Intelligence → Add Locally Hosted → port `8080`
- Dashboard URL
- Manual acceptance checklist from spec (steps 1–6)
- Note: stub does not return `tool_calls` by design

- [ ] **Step 4: Commit**

```bash
git add README.md tests/
git commit -m "docs: add README and complete automated test coverage"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| `GET /v1/models`, `POST /v1/chat/completions` | Task 7 |
| Capture all headers/body, JSONL on finalize | Task 5, 7 |
| Path hints | Task 3, 7 |
| Stub non-stream + stream, no fake tool_calls | Task 6, 7 |
| Invalid JSON → 400 + capture | Task 7 |
| Body 2MB cap | Task 7 (`truncateBody`) |
| Dashboard list/detail/SSE/clear/export | Task 8, 9 |
| Bind 127.0.0.1:8080, no silent port change | Task 1, 7 |
| Mask Authorization in dashboard API | Task 7, 8 |
| No OpenCode / ACP | Global constraints |

No TBD placeholders remain in task steps.

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-08-12-xcode-observer-bridge.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks
2. **Inline Execution** — implement tasks in this session with checkpoints

Which approach do you want?
