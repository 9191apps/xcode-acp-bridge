# Xcode ACP Bridge

Local ACP observer bridge for Xcode Intelligence. Runs Xcode's ACP Agent traffic through an external backend (default: `opencode acp`), tees every JSON-RPC line into per-conversation JSONL files for observation, and serves a web dashboard for inspection.

The bridge is **observe-and-forward**: Xcode spawns the bridge as an ACP Agent, the bridge spawns the configured backend, and every message is forwarded both directions while being recorded. The dashboard shows conversations, timelines, tool calls, and raw JSON-RPC payloads live via SSE.

## Prerequisites

- [Bun](https://bun.sh) (runtime and package manager)

## Install and run

On a new machine (or after a fresh clone), run the setup script. It checks the Bun runtime, installs dependencies, validates every `acp-bridge.config.json` route command (auto-detecting `opencode` and rewriting missing paths with `--write`), prints the exact Xcode ACP Agent registration values, and health-checks the dashboard:

```bash
bun run setup            # full setup (installs deps)
bun run setup --write    # also rewrite missing route commands with a detected binary
bun run setup --skip-install
```

Then start the server:

```bash
bun run start
```

The server binds to `http://127.0.0.1:8787` and exits with an error if the port is already in use (no silent port fallback).

For development with auto-reload:

```bash
bun run dev
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## Xcode setup (ACP Agent)

1. Open **Xcode → Settings → Intelligence**.
2. Choose **Add an ACP Agent** with these absolute paths:

   | Field | Value |
   |---|---|
   | Name | `ACP Bridge` |
   | Executable | `/absolute/path/to/xcode-acp-bridge/src/acp-bridge.ts` |
   | Interpreter | `/absolute/path/to/bun` |
   | Arguments | *(empty)* |

3. Start a **New Conversation** and choose **ACP Bridge**.

## Dashboard

Open in a browser while the server is running:

**http://127.0.0.1:8787/**

The dashboard is a dark "observatory" console focused on ACP conversations, updated live via SSE.

- The **conversation list** shows one row per Xcode spawn / `bridgePid` (not every JSON-RPC line): started time, route, model, project (cwd basename), prompt count, duration, status.
- The **detail pane** shows `cwd`, `MCP_XCODE_SESSION_ID`, OpenCode `sessionId`, and a timeline with tool calls; `session/update` chunks are collapsed. Clicking a timeline row shows the raw JSON-RPC payload with syntax highlighting and one-click copy.
- **Next conversation** dropdowns choose the `routes` entry **and the model** the **next** Xcode conversation will use.
- A conversation can switch model from the detail pane (same backend). **Live** conversations apply immediately; **ended** conversations store the choice against `sessionId` and apply it on the next Xcode resume of that session. Neither overwrites the Next conversation selection. Timeline rows from the bridge are labeled `(bridge)`; live/resume injects use ids `bridge-live-<n>`.
- The model list comes from the route's optional `modelsCommand` (e.g. `opencode models`); without it the dashboard falls back to models observed in past `session/new` results. `GET /api/acp-models?route=<name>&refresh=1` bypasses the in-memory cache.
- When a model is selected, the bridge injects one `session/set_config_option` (id `bridge-<n>`) right after `session/new`; the response is logged but not forwarded to Xcode. Timeline rows from the bridge are labeled `(bridge)`.
- **Clear** and **Export** act on the ACP events store.

## Backends (routes)

Default config ships three routes: `opencode` (default), `cursor` (Cursor CLI `agent acp`), and `qodercli` (Qoder CLI `qodercli --acp`). Pick the next route in the dashboard, then start a **New Conversation** in Xcode.

```json
"routes": {
  "opencode": {
    "command": "~/.opencode/bin/opencode",
    "args": ["acp"],
    "modelsCommand": { "command": "~/.opencode/bin/opencode", "args": ["models"] }
  },
  "cursor": {
    "command": "~/.local/bin/agent",
    "args": ["acp"],
    "modelApply": "spawn-arg",
    "resumeArgs": ["--resume", "{sessionId}"],
    "modelsCommand": { "command": "~/.local/bin/agent", "args": ["models"] }
  },
  "qodercli": {
    "command": "~/.local/bin/qodercli",
    "args": ["--acp"],
    "modelApply": "spawn-arg",
    "resumeMode": "qoder-acp-load",
    "modelsCommand": { "command": "~/.local/bin/qodercli", "args": ["--list-models"] }
  }
}
```

| Field | Meaning |
|---|---|
| `modelApply` | `"inject"` (default): `session/set_config_option` after `session/new`. `"spawn-arg"`: append `--model <id>` at spawn (Cursor, Qoder CLI). |
| `resumeArgs` | Terminal resume argv; `{sessionId}` is substituted. Default `["-s", "{sessionId}"]`. |
| `resumeMode` | `"args"` (default): run `command` + `resumeArgs`. `"cursor-acp-load"`: run `src/acp/cursor-acp-resume.ts` which does ACP `session/load` (CLI `--resume` only covers non-ACP chats). `"qoder-acp-load"`: run `src/acp/qoder-acp-resume.ts` (`session/load` + `qodercli-login`). |

**Cursor auth:** run `agent login` (or set `CURSOR_API_KEY`) before using the `cursor` route. `bun run setup` warns if the agent is not authenticated.

**Cursor extension shim:** Xcode ignores `cursor/*` (e.g. `create_plan`). The bridge converts `create_plan` into a normal message chunk and auto-acks so the agent turn can finish (`src/acp/cursor-shim.ts`).

**Qoder CLI auth:** run `qodercli login` (or set `QODER_PERSONAL_ACCESS_TOKEN`) before using the `qodercli` route. `bun run setup` warns if not authenticated.

**Qoder extension shim:** Xcode ignores `qoder/*`. The bridge auto-acks blocking extension RPCs and suppresses notifications so the agent turn can finish (`src/acp/qoder-shim.ts`).

**Note:** With `modelApply: "spawn-arg"`, the Next-conversation model is applied on **every** bridge spawn (including Xcode resume of an old session), because the model is chosen before the first RPC. Clear the dashboard model selection if you want resume to keep the session’s prior model; live/ended dashboard model changes still use best-effort inject.

The `command` field supports `~` and `$VAR`/`${VAR}` expansion when the config is loaded. Prefer `~/.local/bin/agent` / `~/.opencode/bin/opencode` over machine-specific absolute paths.

CLI shortcut:

```bash
bun run acp-bridge
```

## API surface

| Endpoint | Purpose |
|---|---|
| `GET /health` | Health check |
| `GET /api/acp-events` | Dashboard: list ACP events |
| `GET /acp-events` | Dashboard: SSE live ACP updates |
| `POST /api/acp-events/clear` | Dashboard: clear ACP events |
| `GET /api/acp-events/export` | Dashboard: export ACP events JSON |
| `GET /api/acp-events/:id` | Dashboard: one stored event by id |
| `GET /api/acp-route` | Next-spawn route + model + available names |
| `PUT /api/acp-route` | Set next-spawn route + model (`{ route, model? }`, full replacement) |
| `GET /api/acp-models?route=<name>` | Model list for a route (`source`: command / observed / none) |
| `GET /api/acp-conversations` | Conversation summaries |
| `GET /api/acp-conversation-sessions` | Conversation list grouped by `acpSessionId` (expandable session rows) |
| `GET /api/acp-conversations/:bridgePid` | Timeline for one spawn |
| `PUT /api/acp-conversations/:bridgePid/model` | Set conversation model (`{ model }`). Live process: inject now. Ended (has `sessionId`): apply on next resume. 409 if no session id |
| `POST /api/acp-conversations/:bridgePid/resume` | Open a Terminal with the route’s `resumeArgs` (opencode: `-s <id>`; cursor: `--resume <id>`). 409 if no session id / route |

## Storage

ACP events are stored as **one JSONL file per conversation** under `data/acp-events/` (the legacy single `data/acp-events.jsonl` is auto-migrated on first boot). Consecutive `agent_*_chunk` stream updates are **aggregated into one stored event** by default, shrinking chunk floods by ~96% on disk (disable with `MAX_ACP_CHUNK_AGGREGATE=0`). Memory keeps only a hot ring of the newest `MAX_ACP_EVENTS` (default 20000) events plus incremental conversation summaries; older events are read from disk on demand with a byte-bounded LRU cache. Files idle longer than `MAX_ACP_DAYS` (default 30) are deleted at startup. Both the bridge and the dashboard share the same store class, so appends always land in the right per-conversation file.

To compress data captured **before** chunk aggregation existed, run the one-time compaction (idempotent, skips files written in the last minute):

```bash
bun run scripts/compact-acp.ts
```

## Manual acceptance checklist

For the full “what to test when adding an ACP backend” list, see **[docs/acp-backend-integration.md](docs/acp-backend-integration.md)** (config, turn, models, resume, vendor RPCs, Observatory).

Quick smoke:

1. `bun run start` (restart after code changes); open the dashboard and hard-refresh; Next conversation shows `opencode`
2. Xcode New Conversation → ACP Bridge → prompt; reply finishes normally (no forever spinner)
3. Dashboard: conversations group by `acpSessionId`; expand to see multiple spawns; detail stays per `bridgePid`
4. Select **cursor** (run `agent login` first); New Conversation gets a reply; `process_start` includes `agent` + `acp` (and optional `--model`)
5. `/plan` or a prompt that triggers `cursor/create_plan`: plan body is visible and the turn ends (shim ack)
6. Select **qodercli** (run `qodercli login` first); New Conversation gets a reply; `process_start` includes `qodercli` + `--acp` (and optional `--model`)
7. Live/Ended model change and Observatory resume button: behavior matches that route’s `modelApply` / `resumeMode`

## Development

Run the full automated test suite:

```bash
bun test
```

## License

[MIT](LICENSE) © 2026 91Apps
