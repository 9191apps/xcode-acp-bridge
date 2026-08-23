# ACP Dashboard Model Selection — Design

**Date:** 2026-08-15
**Status:** approved by user (2026-08-15)

## Goal

Let the dashboard be the single control surface for "which ACP backend + which model": pick a route and a model in the dashboard, and the **next** Xcode conversation starts with that backend and has the model applied before its first prompt.

## Context (current implementation)

- `acp-bridge.config.json` defines `routes` (named backends) + `defaultRoute`.
- Dashboard ACP tab has a "Next conversation" dropdown → `PUT /api/acp-route` → writes `data/acp-route.json` (`AcpRouteState = { route }`).
- On each Xcode spawn, `src/acp-bridge.ts` resolves route (state file > `defaultRoute`) and `runBridge` spawns the backend, teeing every stdio line to `data/acp-events.jsonl`. The bridge is a pure transparent forwarder today.

## Validated findings (experiments on 2026-08-15)

1. `opencode acp --help`: **no `--model` flag** → model cannot be passed via spawn args.
2. `opencode acp` `session/new` result contains `configOptions`: a `model` select (17 options, `currentValue`) and a `mode` select (`build`/`plan`).
3. `opencode models` CLI prints the same 17 model ids, one per line.
4. ACP v1 schema: `session/set_config_option` request `{ sessionId, configId, type: "select", value }`; response returns the full updated `configOptions`. (`session/set_mode` exists separately; opencode also exposes mode as a configOption.)
5. Real captures: Xcode uses **UUID strings** as JSON-RPC ids, and its `initialize` `clientCapabilities` = `{ fs, terminal, elicitation }` — **no `session.configOptions` capability**.
6. Injection probe (initialize mimicking Xcode exactly, then `session/new`, then `session/set_config_option`): opencode honors the request anyway; `currentModel` switched `opencode/big-pickle` → `deepseek/deepseek-chat`.

## Design

### 1. Selection state & API

- Extend `AcpRouteState` to `{ route: string, model?: string }` (`src/acp/route-state.ts`).
- `PUT /api/acp-route` body extends to `{ route: string, model?: string | null }`. PUT is **full replacement** of the selection: absent or `null` `model` means "no model selection" (nothing will be injected). Unknown route → 400 as today. Model is **not** validated server-side against the live backend; a stale/unknown model fails visibly at injection time (see §5).
- `GET /api/acp-route` response extends with `model: string | null`.
- Selection applies to the **next** Xcode spawn; the live conversation never switches (same semantics as route today).

### 2. Model list source

- Config: each route gains optional `modelsCommand: { command: string; args: string[] }`. For opencode: `["~/.opencode/bin/opencode", "models"]`. `AcpBackend` becomes `{ command, args, modelsCommand? }`.
- New endpoint `GET /api/acp-models?route=<name>`:
  - If `modelsCommand` configured: spawn it with 5s timeout, parse stdout lines as model ids, cache in memory per route (cache lives until dashboard restarts; `?refresh=1` bypasses the cache). On failure/timeout → fall back to observed cache, response includes `source: "command" | "observed" | "none"` and optional `warning`.
  - If not configured: return observed models with `source: "observed"`.
  - "Observed models" = scan the event store for the newest a2c `session/new` result **of that route** and parse `configOptions` from its `raw` (the full line is already stored, so no new event field is needed for the list). Empty if never observed.

### 3. Bridge injection (`src/acp/run-bridge.ts`)

- New option `pendingModel: string | null` (entry passes `state.model ?? null`).
- Track `pendingSessionNewIds: Set<string|number>` from c2a `session/new` requests.
- On a2c result matching a pending id, with `result.sessionId`: forward the line to Xcode as usual, **then synchronously** write to backend stdin:
  `{"jsonrpc":"2.0","id":"bridge-<n>","method":"session/set_config_option","params":{"sessionId":<sessionId>,"configId":"model","type":"select","value":<model>}}`
  and record the id in `injectedIds: Set<string>`.
- a2c responses whose id is in `injectedIds`: logged to the event store, **not** written to Xcode stdout.
- Ordering: Xcode cannot send `session/prompt` before receiving the `session/new` result; the injection write happens synchronously right after the stdout write, so it reaches the backend before any forwarded prompt.
- Only `session/new` triggers injection in v1 (`session/load`/`session/resume` out of scope). One injection per sessionId.
- Internal shape stays generic (`configId → value`) so `mode` can be added later with the same path.

### 4. Observation

- `parse.ts`: for a2c `session/new` results, extract two summary fields onto `AcpEvent`: `modelCurrent: string | null`, `modelCount: number | null` (the full options list stays available in the event's `raw`, so it is not duplicated into fields).
- Dashboard conversation detail shows current model; the injected request/response appear in the timeline (method `session/set_config_option`, marked as bridge-injected via `bridge-` id prefix).

### 5. Error handling

- `modelsCommand` fails/times out → API falls back to observed list; `warning` string in response; UI shows it inline.
- Injection gets a JSON-RPC error → stored as an event (visible in timeline), session continues untouched.
- `state.model` not in the model list → dashboard shows a hint, bridge still injects (fail visible, not silent).

### 6. Dashboard UI

- Route bar becomes: route select + model select (options reload when route changes) + inline status (source/warning). Selection persists on change (same as today).
- Conversation list/detail gains a "model" column/field (from `modelCurrent` observation or the injected value).

### 7. Testing

- Extend `tests/fixtures/acp-fake-agent.ts`: `session/new` returns `configOptions` (model select with 2 options + currentValue); handle `session/set_config_option` by updating current value and returning updated `configOptions`.
- New tests (`tests/acp-bridge-inject.test.ts` or extend bridge tests):
  - injection happens after `session/new` result and before a following prompt (order in fixture's received lines);
  - injected response is not forwarded to client stdout but is logged;
  - no injection when `pendingModel` is null;
  - error response from backend is logged, session continues.
- Route-state/config tests: extended state round-trip; `modelsCommand` parsing.
- Dashboard API tests: `GET /api/acp-models` (command success, fallback to observed, failure warning); extended `PUT /api/acp-route` with model set/clear.

## Out of scope (v1)

- `mode` (build/plan) selection — structure预留, UI/协议同构，后续单加。
- `session/load` / `session/resume` 注入。
- Mid-conversation switching; argv/env-based route selection.
- Validating model against the backend before injection.
