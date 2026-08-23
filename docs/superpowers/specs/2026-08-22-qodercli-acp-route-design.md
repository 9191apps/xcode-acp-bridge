# Qoder CLI ACP Route — Design

**Date:** 2026-08-22  
**Status:** approved (brainstorm → plan)  
**Scope:** C — Cursor-parity for Qoder CLI (`qodercli --acp`) plus vendor-extension shim if blocking RPCs appear  
**Approach:** 2 — Qoder-specific parallel implementation (do not change Cursor paths)

## Goal

Let the dashboard select Qoder CLI as a next-conversation ACP backend with models listing, reliable model apply at spawn, Terminal resume via ACP `session/load`, and auto-ack of any blocking vendor extension methods — without changing the default OpenCode path or Cursor route behavior.

## Non-goals (v1)

- Switching `defaultRoute` to `qodercli`
- Full interactive UI for Qoder plan / Q&A extensions in Xcode (shim only prevents hangs)
- Guaranteed live mid-session model switch on Qoder (best-effort inject only, same as Cursor)
- Extracting a shared resume framework for Cursor + Qoder (defer until a third ACP-load backend appears)

## Approach

Named route `qodercli` with Cursor-like optional fields and a **separate** resume mode / helper / shim:

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

`defaultRoute` stays `"opencode"`.

**Local probe (1.1.23):** `qodercli --acp` answers `initialize` with `agentInfo.name: "qoder-cli"`, `loadSession: true`, auth method `qodercli-login`. Subcommand `acp` is not the supported entry; use flag `--acp`.

## Model list

`qodercli --list-models` prints a header line `MODEL` then one id per line (e.g. `Qwen3.8-Max`).

`parseModelsOutput` must skip:

- existing: `Available models` (case-insensitive)
- new: exact / case-insensitive header `MODEL`

Otherwise the dashboard would offer a fake model named `MODEL`.

## Model apply

- **Next conversation:** `modelApply: "spawn-arg"` → `resolveBackendSpawnArgs` appends `--model <id>` (existing helper; qodercli accepts `--model` / `-m`).
- Skip entry-time `session/set_config_option` inject for that pending model (same as Cursor).
- **Ended + Xcode resume / live command-file:** keep best-effort inject for all routes.

## Terminal resume

CLI `-r` / `--resume` is **not** the v1 Terminal path (user choice B).

New `resumeMode: "qoder-acp-load"`:

1. Dashboard builds launch argv via `buildResumeLaunchArgs` → `bun src/acp/qoder-acp-resume.ts --agent <command> --session-id <id> [--cwd <path>]`
2. Helper spawns `[agent, "--acp"]` (not `acp` subcommand)
3. JSON-RPC: `initialize` → `authenticate` with `methodId: "qodercli-login"` → `session/load` → interactive `session/prompt`
4. `session/request_permission` → allow-once (mirror Cursor helper)

Cursor’s `cursor-acp-load` / `cursor-acp-resume.ts` remain unchanged.

## Auth

- Pre-auth via `qodercli login` or `QODER_PERSONAL_ACCESS_TOKEN`
- Setup: detect `qodercli` binary; warn if unauthenticated when detectably so
- No bridge-injected login UI in v1

## Vendor extension shim

Xcode will not implement Qoder-private methods. During implementation:

1. Capture real a2c (or fixture from docs / probe) for methods outside standard ACP
2. Add `src/acp/qoder-shim.ts`, wire from `run-bridge.ts` like cursor-shim

| Situation | Behavior |
|-----------|----------|
| Blocking request (has JSON-RPC `id`) | Must ack so prompt can finish |
| Presentable content (plan / notice) | Optional `agent_message_chunk` to Xcode + suppress original |
| Unknown vendor method with `id` | Ack empty accepted; do not forward |
| No vendor methods found | Ship no-op / minimal shim + unit tests for the ack contract |

Prefix unknown until proven (e.g. `qoder/*`); do not assume Cursor’s `cursor/*` set.

## Components

| Piece | Role |
|-------|------|
| `acp-bridge.config.json` | Add `qodercli` route |
| `src/acp/types.ts` / `config.ts` | Extend `AcpResumeMode` with `"qoder-acp-load"` |
| `src/acp/qoder-acp-resume.ts` | Terminal ACP `session/load` client |
| `src/dashboard/acp-routes.ts` | `buildResumeLaunchArgs` / open-terminal branch |
| `src/acp/models.ts` | Skip `MODEL` header |
| `src/acp/qoder-shim.ts` + `run-bridge.ts` | Extension intercept |
| `src/setup-check.ts` / `scripts/setup.ts` | Detect + auth hint |
| Docs | README, `acp-bridge.md`, `acp-backend-integration.md` comparison row |

## Testing

**Automated**

- Config accepts `resumeMode: "qoder-acp-load"`
- `parseModelsOutput` drops `MODEL` header
- `buildResumeLaunchArgs` launches qoder helper with `--acp` agent path
- Shim unit tests for any handled methods (and generic ack-if-id)
- Bridge integration: spawn-arg does not inject on `session/new`; shim path does not forward blocking vendor lines to client stdout

**Manual** (per `docs/acp-backend-integration.md`)

1. Restart dashboard; hard-refresh Observatory; select `qodercli`
2. Xcode New Conversation → full turn with `stopReason`
3. Models dropdown + next-spawn `--model`
4. Close/reopen → same ACP `sessionId`; list groups by session
5. Observatory resume button → Terminal `session/load` works
6. Tool / permission task
7. Prompt that triggers vendor extensions (if any) → no forever spinner

## Success criteria

- Dashboard lists `qodercli` without changing default OpenCode
- New conversation works end-to-end through the bridge
- Model list and spawn-arg model apply work
- Terminal resume uses ACP `session/load`, not CLI `-r`
- No hang on known/unknown blocking vendor RPCs (shim or confirmed absent)
- Cursor and OpenCode routes unchanged in behavior
