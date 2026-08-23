# Cursor CLI ACP Route — Design

**Date:** 2026-08-21  
**Status:** approved (brainstorm → plan)  
**Scope:** B — first-class parity with OpenCode for Cursor CLI (`agent acp`)

## Goal

Let the dashboard select Cursor CLI as a next-conversation ACP backend with models listing, reliable model apply at spawn, and Terminal resume — without changing the default OpenCode path.

## Approach

Named routes gain two optional fields:

| Field | Values | Default |
|-------|--------|---------|
| `modelApply` | `"inject"` \| `"spawn-arg"` | `"inject"` |
| `resumeArgs` | `string[]` with `{sessionId}` placeholder | `["-s", "{sessionId}"]` (resume helper) |

Cursor route:

```json
"cursor": {
  "command": "~/.local/bin/agent",
  "args": ["acp"],
  "modelApply": "spawn-arg",
  "resumeArgs": ["--resume", "{sessionId}"],
  "modelsCommand": {
    "command": "~/.local/bin/agent",
    "args": ["models"]
  }
}
```

`defaultRoute` stays `"opencode"`.

## Model list

`agent models` prints lines like `auto - Auto (default)`. Parser: skip header `Available models`; if line matches `^(\S+)\s+-\s+`, take id; else use the whole trimmed line (OpenCode one-id-per-line).

## Model apply

- **Next conversation (Cursor):** append `--model <id>` to spawn args when `modelApply === "spawn-arg"` and a model is selected. Skip entry-time `session/set_config_option` inject for that pending model (already applied at spawn).
- **Ended + Xcode resume / live command-file:** keep best-effort inject for all routes (sessionId is only known after spawn).
- **OpenCode:** inject-only (unchanged).

## Resume in Terminal

`openTerminalResume` substitutes `{sessionId}` into `backend.resumeArgs` (or default `-s`). UI label is generic “resume”.

## Auth

Pre-auth via `agent login` / `CURSOR_API_KEY`. Setup detects `agent` and warns if unauthenticated. No bridge-injected `authenticate` / `cursor_login` in v1.

## Cursor extension shim

Xcode does not implement `cursor/*` methods. The bridge (`src/acp/cursor-shim.ts`) intercepts a2c:

| Method | Behavior |
|--------|----------|
| `cursor/create_plan` | Forward plan as `agent_message_chunk`; ack nested `{ outcome: { outcome: "accepted" } }` (blocking — without ack, Xcode waits forever) |
| `cursor/update_todos` | Ack if request-shaped; do not forward |
| `cursor/ask_question` | Auto-select first option (or cancel); optional notice chunk |
| other `cursor/*` | Ack empty accepted; do not forward |

## Non-goals

- Full interactive UI for `cursor/ask_question` / plan accept-vs-reject in Xcode
- Switching defaultRoute to cursor
- Guaranteed live mid-session model switch on Cursor
