# ACP Session List Grouping — Design

**Date:** 2026-08-22  
**Status:** approved (brainstorm)  
**Approach:** client-side grouping only (Approach 1)

## Goal

The Observatory conversation list currently shows one row per `bridgePid`. Xcode resume / reopen spawns a new bridge and reuses the same ACP `sessionId` (`session/load` or `session/resume`), so the same backend session appears as multiple rows and looks like multiple ACP sessions.

Make the **list** read as one ACP session, while still allowing inspection of each bridge spawn.

## Approach

Pure grouping in `src/acp/session-list-group.ts` (unit-tested).  
Dashboard adds `GET /api/acp-conversation-sessions` that returns grouped rows (same model/live overlays as the flat list).  
`public/list.js` consumes that endpoint and renders parent/child rows — **no duplicated grouping algorithm in the browser**.

`GET /api/acp-conversations` stays a flat `ConversationSummary[]`. Detail / model / resume stay keyed by `bridgePid`.

*(Amended 2026-08-22: user chose API grouping over client-side port to avoid dual TS/JS logic.)*

## Grouping rules

| Case | Behavior |
|------|----------|
| Has `acpSessionId` | All rows with that id form one **session group** |
| Missing `acpSessionId` | Singleton row keyed by `bridgePid` (not merged) |

Do not require matching `route` for merge (same id almost always same route). If routes differ, still merge; representative spawn supplies parent `route`.

**Representative spawn** (for parent Route / Model / Project and default click target): prefer any spawn with `status === "live"`, else the spawn with the latest `lastActivityAt`.

## Parent row (session)

| Column | Value |
|--------|--------|
| Started | Earliest `startedAt` in the group |
| Route / Model / Project | From representative spawn |
| Prompts / Tools | Sum across spawns |
| Duration | Earliest `startedAt` → latest `lastActivityAt` |
| Status | Any `live` → `live`; else any `error` → `error`; else prefer `stale` if present, else `ended` |
| Extra | Middle-elided short `acpSessionId` + `N spawns` label |

When `N > 1`, show an expand control. When `N === 1`, no expand control (optional short session id still shown).

## Child rows (spawns)

Indent under the parent. Show per-spawn Started, Model, Prompts, Tools, Duration, Status (same spirit as today’s flat row). Put `route · bridgePid` in `title` for hover.

## Click / navigation

- Click **parent** (not the expand control) → `/conversation.html?pid=<representative bridgePid>`
- Click **child** → `/conversation.html?pid=<that bridgePid>`
- Click **expand** → toggle children only; do not navigate

## Expand state

- Default: collapsed
- Persist expand/collapse in `sessionStorage` keyed by `acpSessionId`
- After SSE-driven list reload, re-apply stored expand state

## Filter and count

- Filter matches parent or any child field (existing search text fields plus session id)
- If a child matches, keep the parent visible and auto-expand that group while the filter is non-empty
- Count label: `X sessions (Y spawns)`; with filter, show shown ratios as today-style `a/b`

## Accessibility

- Expand control: `aria-expanded`, `aria-label`
- Rows: `data-session` on parent, `data-pid` on navigable rows (parent uses representative pid for navigation)

## Non-goals

- Changing the flat `/api/acp-conversations` response shape
- Merged multi-spawn timeline on the detail page
- Changing detail URL to session-id based
- Backend event-file coalescing
- Duplicating grouping logic in `public/list.js`

## Tests

- Prefer a small pure helper (e.g. `groupConversationsForList(summaries)`) tested with Bun if extracted to a shared module; otherwise document manual UI check:
  - Two rows same `acpSessionId` → one parent, two children when expanded
  - No id → two separate rows
  - Parent click opens representative (live preferred)
  - Filter on child model still shows parent

## Implementation touchpoints

- `public/list.js` — group, render parent/child, expand, filter, counts
- `public/index.html` — optional column / header tweak only if needed for session chip
- `public/styles.css` — indent, expand button, child row styling
- Optional: tiny `public/` or `src/` helper + unit test for grouping math
