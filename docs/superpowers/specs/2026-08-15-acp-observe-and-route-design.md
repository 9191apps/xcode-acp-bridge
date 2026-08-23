# ACP Observe and Route — Design

Date: 2026-08-15  
Status: Ready for implementation planning  
Repo: `xcode-acp-bridge`

This spec is the product design for **观察 + 路由**. It supersedes the “later phases” notes in `docs/superpowers/specs/2026-08-14-acp-observe-bridge-design.md`. The 2026-08-14 observe tee is the implemented foundation; this document describes the complete product on top of it.

The 2026-08-12 HTTP observer (`/v1/models`, `/v1/chat/completions`, stub model `xcode-observer`) stays as a **separate Xcode face**. It is not an agent path and is not extended here.

## Goal

Xcode Intelligence registers **one** ACP Agent (this repo’s `acp-bridge`). The bridge:

1. **Observes** every JSON-RPC line between Xcode and a real ACP backend, and shows each Xcode conversation as a readable session (not a 1400-row dump of `session/update` chunks).
2. **Routes** the next Xcode conversation to a configured ACP executable (`opencode acp`, later `pi-xcode`, …). The current conversation stays on the backend that was chosen at spawn.

Users switch backends from the existing loopback dashboard. They do not re-register agents in Xcode.

## Evidence (real Xcode ↔ OpenCode capture)

Locked by `data/acp-events.jsonl` from a real conversation (`bridgePid` 49401, OpenCode 1.18.18, Xcode 27.0 27A5237k):

| Fact | Implication |
|---|---|
| One Xcode conversation = one spawn of the bridge = one backend process = one OpenCode `sessionId` (`ses_…`) | Route is chosen at **process start**, not at `session/new` |
| `ses_…` is assigned in the **`session/new` result** (agent → client) | Too late to pick this spawn’s executable |
| `MCP_XCODE_SESSION_ID` is Xcode’s id, in `session/new` params `mcpServers[].env` (with `MCP_XCODE_PID` and `xcrun mcpbridge`) | Display / grouping only; not a spawn key |
| `cwd` is on `session/new` params (observed: a real project path) | Display; do not invent macOS “frontmost project” detection |
| Same conversation: `initialize` → `session/new` → `session/prompt` → …; later `session/cancel` (notification, no JSON-RPC `id`) then another `session/prompt` | History lives in the OpenCode session; do not replay HTTP-style `messages` |
| Tools are MCP (`xcode-tools_XcodeRead` via `session/update` `tool_call`), not ACP `fs/*`, not Chat Completions `tools[]` | Timeline must surface tool calls; chunk spam must collapse |
| JSON-RPC `id` is an Xcode UUID per request | Pairing only; never use as conversation id |
| Almost all events are `session/update` chunks (~1400 for one chat) | Raw event table is the wrong primary UI |

Do not mix these three ids in the UI or in routing:

1. JSON-RPC `id` — request/response pairing
2. ACP `sessionId` (`ses_…`) — assigned by the backend
3. `MCP_XCODE_SESSION_ID` — Xcode’s conversation id

## Product decisions (locked)

| Decision | Choice |
|---|---|
| Xcode registration | **Once**. Name `ACP Bridge`; Executable + Interpreter absolute paths below |
| Routing targets | Multiple **ACP executables** (`opencode acp`, `pi-xcode`, …). Not OpenCode model/provider env splits. Not HTTP/SDK backends |
| How the user picks a backend | Dashboard **“next conversation”** control. Not Xcode `--route` args. Not mid-session hot-swap |
| When a route change applies | Next **spawn** only. Live conversation keeps its backend until Xcode closes stdin |
| Process model | One Xcode spawn → one bridge → one backend process |
| Bytes on the wire | Unchanged JSON-RPC passthrough. No dual ACP SDK. No rewrite of `protocolVersion`, cwd, tools, or session ids |
| Dashboard vs stdio | Thin stdio wrapper **does not** bind HTTP. Existing `bun run start` dashboard tails JSONL |
| HTTP Chat Provider | Keep; out of this product’s implementation |
| Config vs env | Route choice is a **file** under the repo (`data/acp-route.json`). Xcode’s spawn environment is not the user’s shell |

## Architecture

```text
Xcode (ACP Client)          Dashboard (bun run start, :8787)
        │  stdio JSON-RPC              │
        ▼                              │  GET/PUT next route
   acp-bridge.ts                       │  GET conversations
        │  read data/acp-route.json    │
        │  resolve → routes[name]      │
        ├──spawn──►  chosen ACP exe    │
        │  tee stdin/stdout            │
        ▼                              ▼
   data/acp-events.jsonl  ◄── tail ──  ACP tab (conversations + timeline)
```

Two processes, same as phase 1:

- **`acp-bridge`**: Xcode launches this. Spawn, tee, append JSONL, exit. No TCP.
- **Dashboard**: independent. If it is down, the conversation still works; opening the UI later shows the file.

Xcode **Add an ACP Agent** (this machine; do not change):

| Field | Value |
|---|---|
| Name | `ACP Bridge` |
| Executable | `/path/to/xcode-acp-bridge/src/acp-bridge.ts` |
| Interpreter | `~/.bun/bin/bun` |
| Arguments | empty |

```bash
~/.bun/bin/bun /path/to/xcode-acp-bridge/src/acp-bridge.ts
```

## Config

File: `acp-bridge.config.json` at repo root, or `ACP_BRIDGE_CONFIG`. Paths that are not absolute resolve against **repo root** (`src/acp/config.ts` `repoRoot()`), never `process.cwd()`.

Target shape:

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

Rules:

- Every `command` is an **absolute** path. Xcode’s PATH will not find `opencode`.
- `defaultRoute` must be a key in `routes`. Config load fails if it is missing or `routes` is empty.
- Adding `pi-xcode` (or any other ACP binary) is a config edit: another `routes` entry. No code change.
- Backward compatible load: if the file still has `defaultBackend` and no `routes`, treat it as `routes.default` + `defaultRoute: "default"`. After this work ships, the committed repo file uses `routes`.

### Runtime route state

File: `data/acp-route.json` (gitignored via `data/`). Shape:

```json
{ "route": "opencode" }
```

- Dashboard **PUT** writes this file after validating the name against `routes`.
- Bridge **reads** it once at startup, then never again for that process.
- Missing file, invalid JSON, or unknown `route` → use `defaultRoute`, print one line to **stderr** (never ACP stdout), continue.
- Unknown name in config at spawn of a **valid** file pointing at a deleted route: same fallback. Dashboard must not be able to persist an unknown name.

`process_start.raw` records what actually launched:

```json
{ "route": "opencode", "command": "~/.opencode/bin/opencode", "args": ["acp"] }
```

## Session / conversation model

A **conversation** is one `bridgePid`. That is the only grouping key that exists at spawn time.

Derived fields (filled when the corresponding RPC appears; null until then):

| Field | Source |
|---|---|
| `route` | `process_start` |
| `cwd` | `session/new` params `cwd` |
| `mcpXcodeSessionId` | first string value of key `MCP_XCODE_SESSION_ID` in that `session/new` payload |
| `acpSessionId` | `sessionId` / `session_id` from `session/new` **result** (also appears later in `sessionHints`) |
| `live` | `process_end` / `process_start_error` absent |
| `promptCount` | count of `session/prompt` methods |
| `toolCallCount` | count of `session/update` with `sessionUpdate === "tool_call"` (not `tool_call_update`) |

Do **not** invent a synthetic conversation id. Show the three real ids in the detail header.

Aggregator is a **pure function over the event list**. Do not rewrite JSONL. Old events without new structured fields must still aggregate by parsing `raw`.

## Event record (additive)

Keep the phase-1 `AcpEvent` fields. Add nullable structured fields so the dashboard does not re-parse every line in the common case:

| Field | Meaning |
|---|---|
| `route` | Route name on `process_start` / `process_start_error`; null on other kinds |
| `cwd` | From `session/new` params; else null |
| `mcpXcodeSessionId` | From payload walk; else null |
| `sessionUpdate` | `params.update.sessionUpdate` when method is `session/update`; else null |
| `toolName` | First non-empty of `update.title`, `update.name`, `update.kind` when `sessionUpdate` is `tool_call` or `tool_call_update`; else null |

`sessionHints` stays: still collect `sessionId` / `session_id`. Also include `MCP_XCODE_SESSION_ID` values in `sessionHints` so existing highlight still works.

Parse failures: forward the line; leave new fields null; set `parseError`.

## Dashboard (ACP tab)

HTTP tab is unchanged. ACP tab is **conversation-first**.

### Route bar (always visible on ACP tab)

- Label: **Next conversation**
- `<select>` of `Object.keys(routes)`
- Current value = `data/acp-route.json` if valid, else `defaultRoute`
- Changing it PUTs immediately. Copy: **Applies to the next Xcode conversation. The current one is unchanged.**
- If a conversation is `live`, its row shows that conversation’s **locked** `route` (from `process_start`), which may differ from the dropdown.

### List

One row per conversation (`bridgePid`), newest first:

| Column | Content |
|---|---|
| Started | `process_start.ts` |
| Route | locked route or `—` |
| Project | basename of `cwd`, or `—` |
| Prompts | `promptCount` |
| Status | `live` / `ended` / `error` |

Click a row → detail.

### Detail

Header: `bridgePid`, `backendPid`, `route`, full `cwd`, `MCP_XCODE_SESSION_ID`, ACP `sessionId`.

Timeline (oldest first), not the raw 1400 lines:

**Always a row**

- `process_start`, `process_start_error`, `process_end`
- RPC methods: `initialize`, `authenticate`, `session/new`, `session/prompt`, `session/cancel`
- `session/update` with `sessionUpdate === "tool_call"` (show `toolName`)

**Collapsed**

- Consecutive `session/update` whose `sessionUpdate` is `agent_message_chunk` or `agent_thought_chunk` → one row: `N chunks`
- Consecutive `session/update` with `sessionUpdate === "tool_call_update"` that immediately follow a `tool_call` row → do not add new rows; set `updateCount` on that tool row. A `tool_call_update` with no preceding `tool_call` in this conversation is its own `tool_call` row (`name` from `toolName` or `"tool_call_update"`).

**Everything else**

- One row per event, method or kind as label (so unknown methods are not dropped).

Click a timeline row → show that event’s `raw` (for a chunk group, show the last event’s raw and the count). Keep a **Raw events** disclosure at the bottom listing every event for that `bridgePid` (escape hatch; not the default view).

### Live updates

Existing SSE `/acp-events` stays. On each `acp` event, refresh conversation summaries (cheap: re-aggregate in memory). Clear/Export still operate on the JSONL (all events), not a single conversation.

### APIs

| Endpoint | Purpose |
|---|---|
| `GET /api/acp-events` | Unchanged: full event list |
| `GET /acp-events` | Unchanged SSE |
| `POST /api/acp-events/clear` | Unchanged |
| `GET /api/acp-events/export` | Unchanged |
| `GET /api/acp-route` | `{ route, defaultRoute, routes: string[], source: "state" \| "default" }` |
| `PUT /api/acp-route` | Body `{ "route": "opencode" }`. 400 if unknown. Writes `routeStatePath` |
| `GET /api/acp-conversations` | `ConversationSummary[]` newest first |
| `GET /api/acp-conversations/:bridgePid` | `ConversationDetail` (summary + timeline). 404 if none |

The bridge still does not POST to the dashboard.

## Bridge lifecycle (unchanged except route resolve)

```text
1. User starts a New Conversation with ACP Bridge in Xcode
2. Xcode spawns acp-bridge (stdio)
3. Bridge loads config + route state, resolves executable, spawns it, appends process_start
4. Tee + JSONL as today
5. Stdin EOF: end backend stdin, drain up to 2s, then kill; process_end; exit 0
6. Spawn failure: process_start_error (include attempted route + command); exit non-zero
```

No retry, no failover to another route, no second spawn in the same process.

## Error handling

| Case | Behavior |
|---|---|
| Config missing / invalid JSON / empty routes / unknown `defaultRoute` | Bridge and dashboard fail at load with a clear stderr message |
| Route state missing or stale | `defaultRoute`; stderr warning; conversation proceeds |
| PUT unknown route | HTTP 400; file unchanged |
| Backend executable missing | `process_start_error`; exit 1; Xcode sees agent launch failure |
| Line is not JSON | Forward as-is; `parseError` |
| JSONL write fails | Keep forwarding ACP; stderr |
| Line > 2MB | Forward full bytes; store truncated `raw` |
| Two conversations at once | Two bridge processes; same JSONL; two conversation rows |
| Dashboard down | Bridge unaffected |
| `authenticate` | Pass through; no secrets injected |
| `session/cancel` | Pass through; timeline row |

## Out of scope

- Dual ACP SDK (Agent facing Xcode + Client facing backend)
- Rewriting JSON-RPC, injecting cwd, filtering tools
- Mid-session executable switch
- Choosing a route from `session/new` / `MCP_XCODE_SESSION_ID` / `ses_…`
- Chat Completions as an agent; translating HTTP ↔ ACP
- Binding a TCP port inside `acp-bridge`
- Detecting the frontmost Xcode project via macOS APIs
- OpenCode model/provider routing via env
- Compiling `bun build --compile` (docs may mention it; not required)
- Shipping a `pi-xcode` binary or its path in default config

## Testing

### Automated

- Config: `routes` + `defaultRoute`; `defaultBackend` compat; `eventsPath` / `routeStatePath` vs repo root; reject empty routes
- Route state: missing file → null; valid `{route}`; invalid JSON → null
- `resolveRoute`: state wins; unknown/missing falls back to default
- Parse: `cwd`, `MCP_XCODE_SESSION_ID`, `sessionUpdate`, `toolName`; `sessionHints` includes both `ses_…` and MCP id
- Conversations: two `bridgePid`s → two summaries; prompt count; live vs ended; chunk collapse; tool_call rows
- Bridge: spawn uses resolved command; `process_start.raw` contains `route`; unknown state file still spawns default
- Dashboard: GET/PUT route; PUT 400; GET conversations matches aggregator; 404 unknown pid
- Existing tee tests still pass (forward, parseError, truncate, stdin EOF exit 0)

### Manual acceptance

1. `bun run start`; open ACP tab; Next conversation shows `opencode`
2. Xcode New Conversation → ACP Bridge → prompt; reply quality same as direct `opencode acp`
3. Dashboard: **one** conversation row; header shows cwd, `MCP_XCODE_SESSION_ID`, `ses_…`; timeline shows prompt + tool_call, not thousands of chunks
4. Add a second route in config pointing at the existing fake-agent fixture (or a second copy of opencode). Select it as Next conversation. **Current** Xcode chat still talks to opencode. **New** Conversation uses the second route (`process_start.route` matches)
5. Stop dashboard, send another prompt in an existing live chat: still works. Reopen dashboard: conversation is there
6. Invalid `data/acp-route.json` (`{"route":"nope"}`): next spawn uses `opencode`, stderr mentions fallback

### Done when

Automated tests pass. Manual 1–4 are reliable. 5–6 have been run once and noted. HTTP observer still works on :8787.

## What already exists (do not rebuild)

- `src/acp-bridge.ts`, `src/acp/run-bridge.ts` tee + lifecycle
- `src/acp/event-store.ts`, `src/acp/tail.ts`, `src/acp/parse.ts` (hints for `sessionId` only)
- Dashboard ACP event table + SSE + clear/export
- `acp-bridge.config.json` with `defaultBackend` only

This spec adds: route table, route state file, spawn-time resolve, conversation aggregation, conversation UI, identity fields from real captures.
