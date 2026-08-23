# Xcode Intelligence Observer Bridge — Design

Date: 2026-08-12  
Status: Draft for implementation planning  
Repo: `xcode-acp-bridge`

## Goal

Build a local web app that Xcode Intelligence can use as a **Locally Hosted** chat provider. Phase 1 is an **observation stub**: capture everything Xcode sends to OpenAI-compatible endpoints, show it in a dashboard, and return a minimal compatible reply so Xcode completes the request. Do **not** connect OpenCode yet.

Later phases (out of scope for this spec) may:

- Spawn `opencode serve` and proxy completions through OpenCode as a model brain
- Keep Xcode Agent Mode as the tool owner (OpenCode tools disabled)
- Derive working directory / project path from observed payloads or Xcode process detection

## Product decisions (locked)

| Decision | Choice |
|---|---|
| Xcode role | Agent Mode / Intelligence owns tools and edits |
| Bridge role (phase 1) | Capture + stub only |
| Upstream OpenCode | Not wired in phase 1 |
| ACP | Explicitly rejected for the “model brain” path; may revisit only if product goal changes |
| Shape | Independent web app (provider API + dashboard) |
| OpenCode lifecycle (future) | App-managed `opencode serve` (decision B), after observation |
| Working directory (future) | Prefer detecting current Xcode project (decision C), but only after payload inspection proves what Xcode sends |

## Architecture

One local process, two faces:

1. **Provider face** for Xcode  
   - `GET /v1/models`  
   - `POST /v1/chat/completions`  
2. **Dashboard face** for humans  
   - Live list of captures  
   - Detail view: headers, raw body, stub response, path hints  

```text
Xcode Intelligence  --HTTP-->  Provider (/v1/*)  --stub-->  Xcode
                                   |
                                   +-->  Capture Store  -->  Dashboard
```

Bind to `127.0.0.1` only. Default port `8080` (configurable via env/flag). Port must not silently change on conflict — Xcode is configured with an explicit port.

## Components

### 1. `ProviderServer`

Local HTTP server (recommended stack: **Bun + Hono** + minimal static dashboard assets).

Responsibilities:

- Serve provider endpoints under `/v1/*`
- Serve dashboard UI and small JSON/SSE APIs for the UI
- Refuse or ignore non-loopback access by binding `127.0.0.1`

### 2. `CaptureStore`

In-memory list plus file persistence for every provider request.

Storage: `./data/captures.jsonl` (one **complete** JSON object per line).

Persistence rule for phase 1: keep the in-flight capture in memory (so the dashboard can show “pending”), then **append exactly one final JSONL line** when the stub response finishes or the client aborts. Do not rewrite earlier lines. “Clear” truncates/replaces the JSONL file and resets memory.

Each record includes at least:

- `id` (stable unique id)
- `ts` (ISO timestamp)
- `method`, `path`
- `headers` (object; full values on disk)
- `rawBody` (string; may be truncated)
- `bodyTruncated` (boolean)
- `parseError` (string | null)
- `summary`: `{ model?, stream?, messageCount?, hasTools?, toolCount? }`
- `pathHints`: `string[]` (regex hits from headers + body)
- `response`: stub or error payload we returned
- `statusCode`
- `durationMs`
- `clientAborted` (boolean, for mid-stream disconnects)

Dashboard display may mask `Authorization` / API-key-looking headers; disk keeps originals for analysis.

### 3. `StubResponder`

Builds OpenAI-compatible responses without calling a model.

Rules:

- Non-stream: `object: "chat.completion"` with one assistant message (short text such as “Captured by xcode-acp-bridge”)
- Stream: SSE `chat.completion.chunk` events with at least one `delta.content` chunk, then a final chunk with `finish_reason: "stop"`
- If request includes `tools` / `tool_choice`: still return **text-only** stub — **never fabricate `tool_calls`**
- Mark `summary.hasTools` when tools are present so the dashboard can filter those captures

Fixed catalog model for listing:

- id: `xcode-observer`
- Enough fields for Xcode’s model picker to show something selectable

### 4. `Dashboard`

Thin browser UI (plain HTML/JS or a tiny Vite page is fine).

Features:

- Capture list: time, model, stream flag, hasTools, status, duration
- Live updates via SSE (`GET /events`) as primary; short polling (`GET /api/captures`) as fallback only if needed
- Detail pane: formatted JSON for headers/body/response + highlighted `pathHints`
- Actions: clear captures, export JSON/JSONL

## Data flow

```text
1. Xcode POST /v1/chat/completions (or GET /v1/models)
2. ProviderServer reads method, path, headers, raw body
3. Attempt JSON parse; on failure set parseError, keep rawBody
4. CaptureStore.createPending(record) + emit dashboard “pending” event
5. StubResponder.build(...) or error envelope (stream stub if needed)
6. CaptureStore.finalize(record with response, statusCode, durationMs)
   → append one JSONL line + emit dashboard “final” event
7. Return response to Xcode (already streaming if applicable)
```

Conversation grouping: **do not invent** session IDs in phase 1. List chronologically. If Xcode payloads contain conversation/session/path fields, surface them in the UI for later design.

Path hinting: run regexes over headers + raw body for absolute POSIX paths, `.xcodeproj` / `.xcworkspace`, and `file://` URLs. Store hits in `pathHints`. Do not change routing or cwd based on hints in phase 1.

## Error handling

| Case | Behavior |
|---|---|
| Invalid JSON body | Persist raw; return `400` with OpenAI-style `error`; set `parseError` |
| Missing/weird `messages` | Persist; prefer `200` text stub explaining capture so Xcode keeps sending |
| `stream: true` | SSE stub; on client disconnect mark `clientAborted` |
| Body larger than 2MB | Truncate stored body, set `bodyTruncated`, still stub |
| JSONL write failure | Still return stub if possible; log error; UI shows persistence failure |
| Port in use | Fail startup with clear message; do not auto-pick another port |
| Auth header present | Do not validate in phase 1; capture and optionally mask in UI |

Repeated Xcode retries caused by missing `tool_calls` are expected observation signal — each attempt is a new capture.

## Out of scope (phase 1)

- Spawning or talking to `opencode serve`
- ACP / Agent Client Protocol
- Detecting the frontmost Xcode project via macOS APIs
- Forwarding or executing tools
- Fancy auth between Xcode and this bridge
- Production hardening beyond loopback binding and basic size limits

## Testing

### Automated

- `GET /v1/models` → 200 and includes `xcode-observer`
- Non-stream `POST /v1/chat/completions` → valid stub shape + JSONL append
- Stream `POST` → SSE with content chunk and terminal `finish_reason`
- Invalid JSON → capture with `parseError` + error response
- Request with `tools` → `hasTools: true`, stub has no `tool_calls`
- Body containing a sample `.xcodeproj` path → non-empty `pathHints`

### Manual acceptance

1. Start server; open dashboard in browser
2. In Xcode: Settings → Intelligence → Add Locally Hosted provider on the same port
3. Model list appears (at least `xcode-observer`)
4. Send a simple chat message; dashboard shows a completions capture with full headers/body
5. If available, try Agent Mode with an edit intent; note whether `tools` appear and whether Xcode retries
6. From real captures, answer: does Xcode send a project path? Where (header, system, message content, elsewhere)?

### Done when

Manual steps 1–4 are reliable. Steps 5–6 produce a written observation (presence or absence of path/tools is a valid result). OpenCode integration is not required for phase 1 done.

## Future phase sketch (non-binding)

After observation:

1. Decide cwd strategy from real payloads (and optionally Xcode process detection)
2. Have the web app spawn `opencode serve` with that cwd
3. Translate `/v1/chat/completions` ↔ OpenCode HTTP/SDK while disabling OpenCode-owned tools
4. Pass through Xcode `tools` / `tool_calls` so Xcode remains the agent

## Open questions to close with phase-1 captures

1. Exact request shape Xcode uses for Chat vs Agent Mode
2. Whether/where project paths appear
3. Streaming vs non-streaming preference
4. Header conventions (`Authorization`, custom headers)
5. How Xcode behaves when the model returns text instead of `tool_calls`
