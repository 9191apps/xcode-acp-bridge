# ACP Live Model Switch (same backend) — Design

**Date:** 2026-08-15
**Status:** draft, pending user review

## Goal

Let the user switch the model of a **live** ACP conversation from the dashboard: pick a live conversation, choose a model, and the bridge injects `session/set_config_option` into the running backend mid-conversation. Follow-up prompts in that conversation use the new model.

Decisions already made with the user:

- Scope is **per live conversation only** — it does **not** write through to `data/acp-route.json` (the "next conversation" selection stays untouched).
- A conversation is addressed by **bridgePid** (conversations are grouped/keyed by bridgePid; live conversation ⇔ bridge process is 1:1).

## Context (current implementation)

- `runBridge` (`src/acp/run-bridge.ts`) already supports one-shot injection: after a `session/new` result it writes `session/set_config_option` with id `bridge-<n>`, logs both directions, and suppresses the injected response from Xcode stdout (`injectedIds`).
- `parse.ts` already extracts `modelCurrent`/`modelCount` from `configOptions` in any a2c result; `ConversationSummary.model` = `lastNonNull(modelCurrent)` (`src/acp/conversations.ts:249`). So a live switch becomes visible in list + detail automatically once the response event lands.
- Dashboard (`src/dashboard/acp-routes.ts`) has `GET /api/acp-models?route=` (command/observed sources) and `GET /api/acp-conversations[/:bridgePid]`.
- The bridge process has **no inbound control channel** today (dashboard only tails the JSONL store). This feature adds one.

## Design

### 1. Control channel: per-conversation command file

- Directory: `acp-commands/` next to the events file, derived from `eventsPath`: `path.join(path.dirname(eventsPath), "acp-commands")`. No new config field.
- File: `<bridgePid>.json`, content `{ "model": string, "ts": number }` (epoch ms).
- New shared module `src/acp/commands.ts`:
  - `commandsDirFor(eventsPath: string): string`
  - `writeModelCommand(eventsPath: string, bridgePid: number, model: string): void` — ensures dir, writes `<pid>.<rand>.tmp` then `rename` → atomic; `ts: Date.now()`.
  - `readModelCommand(path: string): { model: string, ts: number } | null` — parse + shape-check, `null` on any error.
- Why a file: no ports/permissions, survives dashboard restart ordering, trivially inspectable. Latency is effectively instant with `fs.watch`, with a stat-based fallback (§2).

### 2. Bridge side (`src/acp/run-bridge.ts`)

New option: `commandsDir?: string` (default `commandsDirFor(eventsPath)`; injectable for tests).

State additions:

- `startedAtMs = Date.now()` at start.
- `lastSessionId: string | null` — updated from (a) c2a `session/new`/`session/resume`/`session/load` request `params.sessionId`, and (b) a2c `session/new` result `result.sessionId` (existing `sessionIdFromNewResultRaw`). This covers both new and resumed conversations.
- `appliedModel: string | null` — initialized to `pendingModel` (the session-start injection, if any).
- `desiredLiveModel: string | null` — last valid model read from the command file.

Watch + apply:

- Watch `commandsDir` with `fs.watch` (watch the **directory**; the file may not exist at bridge start). Filter for own filename.
- Fallback: on every c2a line, `statSync` the command file and re-check if `mtimeMs` changed (cheap; covers missed watch events).
- On any trigger: read file; ignore if unreadable, `ts < startedAtMs` (stale file from a reused PID), or `model === desiredLiveModel` (already handled).
- Set `desiredLiveModel = model`, then `maybeApplyLiveModel()`:
  - Preconditions: `lastSessionId !== null`, `desiredLiveModel !== appliedModel`.
  - Inject `{"jsonrpc":"2.0","id":"bridge-live-<n>","method":"session/set_config_option","params":{"sessionId":lastSessionId,"configId":"model","type":"select","value":desiredLiveModel}}` — same write path as the session-start injection (`logRpc("c2a", …)` + `proc.stdin.write`), id added to the existing `injectedIds` set so its response is logged-but-not-forwarded (existing suppression logic unchanged).
  - `appliedModel = desiredLiveModel` is set **at write time** (the result arrives asynchronously).
  - If `lastSessionId` is not known yet (command arrived before `session/new` result), stay pending — `maybeApplyLiveModel()` is also called whenever `lastSessionId` changes, so it applies as soon as the session id appears.
- If the agent answers the injected request with an **error**, log-only (the timeline shows it); since `appliedModel` already advanced there is no retry loop. The user can re-pick the model to retry.
- Timing: injected immediately even mid-turn. JSON-RPC allows interleaved requests; the in-flight turn may finish on the old model (agent-defined), the next turn uses the new one. No queueing/turn-boundary wait in v1.
- Cleanup: on exit (alongside `appendProcessEnd`), best-effort `rm` own command file.

### 3. Dashboard API (`src/dashboard/acp-routes.ts`)

`PUT /api/acp-conversations/:bridgePid/model` with body `{ "model": string }`:

- 400 if `model` is not a non-empty string.
- 404 if no conversation with that bridgePid (`conversationDetail(store.list(), pid)`).
- 409 `{ error: "conversation not live" }` if `status !== "live"` (ended/error conversations are immutable).
- Success: `writeModelCommand(config.eventsPath, pid, model)` → `200 { ok: true, bridgePid, model }`.
- The response is fire-and-forget: confirmation arrives asynchronously via the injected request/response events (SSE refresh updates the model column). Does **not** touch `routeStatePath`.

### 4. UI (`public/app.js`, `public/index.html`, minimal CSS)

- Conversation detail header: the `model:` line becomes a `<select id="acp-live-model">` **only when `d.status === "live"` and `d.route` is known**; otherwise stays plain text (ended/error read-only).
- Options loaded from the existing `GET /api/acp-models?route=<d.route>` (per-route in-memory cache in JS, refreshed when detail opens). Current value = `d.model` (fall back to a `(backend default)` empty option when `d.model` is null).
- `change` → `PUT /api/acp-conversations/:pid/model`; on non-2xx show the error in a new small hint span (`acp-live-model-status`) next to the select in the detail header, and revert the select to `d.model`.
- Re-render guard: the SSE-driven debounced `loadAcpDetail` rebuilds `detailEl.innerHTML`; skip rebuilding while the live-model select has focus (`focusin`/`focusout` flag), same spirit as the existing `acpSelectedEventId` guard.
- Conversation **list** model column stays read-only; it updates via the normal SSE refresh once the injected response lands.
- Timeline already renders injected `session/set_config_option` entries with the `bridge-` id prefix styling from the previous feature.

### 5. Error handling

| Case | Behavior |
|---|---|
| Command file unreadable/invalid JSON | Bridge ignores (readModelCommand → null); dashboard PUT already validated input |
| Stale file (`ts < startedAtMs`, PID reuse) | Ignored; bridge deletes its file on exit to reduce leftovers |
| Conversation ended between UI render and PUT | 409; UI shows the error |
| Agent returns error for injected request | Logged in timeline, no retry loop; user can re-pick |
| Agent never heard of the model id (typo from stale list) | Same as above — visible in timeline |
| Dashboard restarted while bridge lives | Command file persists; bridge unaffected |
| Multiple quick switches | File holds latest only; `desiredLiveModel` dedupe means bridge applies at most once per distinct value |

### 6. Testing

- `tests/acp-commands.test.ts` (new): write/read roundtrip incl. atomic rename, invalid JSON → null.
- `tests/acp-bridge.test.ts` (extend, using `commandsDir` override + fake agent):
  - live switch mid-session: write command file after `session/new` → fake agent receives `session/set_config_option` with the given value; response suppressed from client stdout; event with `modelCurrent` recorded.
  - command file written **before** `session/new` result → applied once session id is known.
  - stale `ts` (older than bridge start) → never applied.
  - repeated same value → applied once.
  - resumed conversation (c2a `session/resume` with `params.sessionId`) → live switch works without any `session/new`.
- `tests/acp-dashboard.test.ts` (extend): PUT live → 200 + file contents; PUT ended → 409; unknown pid → 404; bad body → 400; route state file untouched.
- UI: manual verification (existing dashboard tests don't cover DOM).

### 7. Out of scope (YAGNI)

- Switching the **backend/route** of a live conversation (session state lives in the backend process; impossible without history transfer).
- Unix socket / HTTP reverse channel (file is sufficient at this scale).
- Write-through to `data/acp-route.json` (user decision: session-only).
- Retry/ack protocol, turn-boundary scheduling, mode (`build`/`plan`) live switching (same path can add it later).
