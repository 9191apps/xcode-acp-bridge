# ACP Session List Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group Observatory list rows by `acpSessionId` so one ACP session shows as one parent row, with expandable per-`bridgePid` spawn children.

**Architecture:** Pure grouping in `src/acp/session-list-group.ts` (unit-tested). Dashboard exposes `GET /api/acp-conversation-sessions` that returns grouped rows (same overlays as the flat list). `public/list.js` consumes that endpoint only — no duplicated grouping algorithm in the browser. Flat `GET /api/acp-conversations` and detail / model / resume stay `bridgePid`-keyed.

**Tech Stack:** Bun, TypeScript, Hono, `bun:test`, existing `public/` HTML/JS/CSS (no bundler).

## Global Constraints

- Single source of truth for grouping: `src/acp/session-list-group.ts` — do **not** reimplement the algorithm in `public/list.js`
- Keep `GET /api/acp-conversations` flat shape unchanged; add `GET /api/acp-conversation-sessions` for the list UI
- Do not build a merged session timeline detail page
- Detail / model / resume remain `/conversation.html?pid=` and existing APIs
- Work on branch `main` (user approved)
- Spec: [docs/superpowers/specs/2026-08-22-acp-session-list-grouping-design.md](../specs/2026-08-22-acp-session-list-grouping-design.md) — Approach amended 2026-08-22: API grouping instead of client-side port (user chose 1B)

---

## File map

| File | Role |
|------|------|
| `src/acp/session-list-group.ts` | Pure grouping + representative + status/duration aggregates |
| `tests/acp-session-list-group.test.ts` | Unit tests for grouping |
| `src/dashboard/acp-routes.ts` | `GET /api/acp-conversation-sessions` |
| `tests/acp-dashboard.test.ts` | API test for grouped endpoint |
| `public/list.js` | Render groups from API, expand, filter, counts, click routing |
| `public/styles.css` | Expand button, parent/child row styles |
| `public/index.html` | Filter placeholder / count label only if copy changes |
| `docs/acp-bridge.md` | Note list groups by session via new endpoint |

---

### Task 1: Grouping helper + unit tests

**Files:**
- Create: `src/acp/session-list-group.ts`
- Create: `tests/acp-session-list-group.test.ts`
- Consumes: `ConversationSummary` from `src/acp/conversations.ts`
- Produces: `groupConversationsForList`, `SessionListGroup`, `pickRepresentative`

- [ ] **Step 1: Write the failing test file**

Create `tests/acp-session-list-group.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ConversationSummary } from "../src/acp/conversations";
import {
  groupConversationsForList,
  pickRepresentative,
} from "../src/acp/session-list-group";

function row(partial: Partial<ConversationSummary> & Pick<ConversationSummary, "bridgePid">): ConversationSummary {
  return {
    backendPid: null,
    route: "cursor",
    cwd: "/Users/x/Proj",
    mcpXcodeSessionId: null,
    acpSessionId: null,
    startedAt: "2026-08-21T14:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-08-21T15:00:00.000Z",
    status: "ended",
    durationMs: 3600_000,
    promptCount: 1,
    toolCallCount: 2,
    eventCount: 10,
    model: "m1",
    ...partial,
  };
}

describe("pickRepresentative", () => {
  test("prefers live over newer ended", () => {
    const live = row({
      bridgePid: 1,
      status: "live",
      lastActivityAt: "2026-08-21T14:00:00.000Z",
    });
    const ended = row({
      bridgePid: 2,
      status: "ended",
      lastActivityAt: "2026-08-22T14:00:00.000Z",
    });
    expect(pickRepresentative([ended, live]).bridgePid).toBe(1);
  });

  test("without live picks latest lastActivityAt", () => {
    const a = row({ bridgePid: 1, lastActivityAt: "2026-08-21T14:00:00.000Z" });
    const b = row({ bridgePid: 2, lastActivityAt: "2026-08-22T14:00:00.000Z" });
    expect(pickRepresentative([a, b]).bridgePid).toBe(2);
  });
});

describe("groupConversationsForList", () => {
  test("merges same acpSessionId into one group with two spawns", () => {
    const a = row({
      bridgePid: 76202,
      acpSessionId: "bd4d53b5-57ce-4ebd-a48d-c7b2b7e9d426",
      startedAt: "2026-08-21T14:36:34.771Z",
      lastActivityAt: "2026-08-22T05:15:00.000Z",
      status: "ended",
      promptCount: 12,
      toolCallCount: 70,
      durationMs: 1000,
    });
    const b = row({
      bridgePid: 99629,
      acpSessionId: "bd4d53b5-57ce-4ebd-a48d-c7b2b7e9d426",
      startedAt: "2026-08-22T05:17:25.096Z",
      lastActivityAt: "2026-08-22T08:00:00.000Z",
      status: "live",
      promptCount: 8,
      toolCallCount: 48,
      durationMs: 2000,
      model: "m2",
    });
    const groups = groupConversationsForList([a, b]);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.kind).toBe("session");
    if (g.kind !== "session") throw new Error("expected session");
    expect(g.acpSessionId).toBe("bd4d53b5-57ce-4ebd-a48d-c7b2b7e9d426");
    expect(g.spawns.map((s) => s.bridgePid).sort()).toEqual([76202, 99629]);
    expect(g.representative.bridgePid).toBe(99629);
    expect(g.promptCount).toBe(20);
    expect(g.toolCallCount).toBe(118);
    expect(g.status).toBe("live");
    expect(g.startedAt).toBe("2026-08-21T14:36:34.771Z");
    expect(g.lastActivityAt).toBe("2026-08-22T08:00:00.000Z");
    expect(g.durationMs).toBe(Date.parse(g.lastActivityAt) - Date.parse(g.startedAt));
  });

  test("rows without acpSessionId stay singletons", () => {
    const a = row({ bridgePid: 1, acpSessionId: null });
    const b = row({ bridgePid: 2, acpSessionId: null });
    const groups = groupConversationsForList([a, b]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.kind === "singleton")).toBe(true);
  });

  test("groups ordered by earliest startedAt descending", () => {
    const old = row({
      bridgePid: 1,
      acpSessionId: "sess-old",
      startedAt: "2026-08-01T00:00:00.000Z",
    });
    const neu = row({
      bridgePid: 2,
      acpSessionId: "sess-new",
      startedAt: "2026-08-20T00:00:00.000Z",
    });
    const groups = groupConversationsForList([old, neu]);
    expect(groups.map((g) => (g.kind === "session" ? g.acpSessionId : g.spawn.bridgePid))).toEqual([
      "sess-new",
      "sess-old",
    ]);
  });

  test("status: error wins over ended when no live", () => {
    const ended = row({ bridgePid: 1, acpSessionId: "s", status: "ended" });
    const err = row({ bridgePid: 2, acpSessionId: "s", status: "error" });
    const g = groupConversationsForList([ended, err])[0]!;
    expect(g.kind).toBe("session");
    if (g.kind === "session") expect(g.status).toBe("error");
  });

  test("status: stale preferred over ended when no live/error", () => {
    const ended = row({ bridgePid: 1, acpSessionId: "s", status: "ended" });
    const stale = row({ bridgePid: 2, acpSessionId: "s", status: "stale" });
    const g = groupConversationsForList([ended, stale])[0]!;
    expect(g.kind).toBe("session");
    if (g.kind === "session") expect(g.status).toBe("stale");
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (module missing)**

Run: `bun test tests/acp-session-list-group.test.ts`

Expected: fail resolving `../src/acp/session-list-group`

- [ ] **Step 3: Implement `src/acp/session-list-group.ts`**

```ts
import type { ConversationStatus, ConversationSummary } from "./conversations";

export type SessionListGroup =
  | {
      kind: "session";
      acpSessionId: string;
      spawns: ConversationSummary[];
      representative: ConversationSummary;
      startedAt: string;
      lastActivityAt: string;
      durationMs: number;
      status: ConversationStatus;
      promptCount: number;
      toolCallCount: number;
      route: string | null;
      model: string | null;
      cwd: string | null;
    }
  | {
      kind: "singleton";
      spawn: ConversationSummary;
    };

export function pickRepresentative(spawns: ConversationSummary[]): ConversationSummary {
  if (spawns.length === 0) {
    throw new Error("pickRepresentative: empty spawns");
  }
  const live = spawns.filter((s) => s.status === "live");
  const pool = live.length > 0 ? live : spawns;
  return pool.reduce((best, cur) =>
    cur.lastActivityAt > best.lastActivityAt ? cur : best,
  );
}

function aggregateStatus(spawns: ConversationSummary[]): ConversationStatus {
  if (spawns.some((s) => s.status === "live")) return "live";
  if (spawns.some((s) => s.status === "error")) return "error";
  if (spawns.some((s) => s.status === "stale")) return "stale";
  return "ended";
}

export function groupConversationsForList(
  rows: ConversationSummary[],
): SessionListGroup[] {
  const bySession = new Map<string, ConversationSummary[]>();
  const singletons: ConversationSummary[] = [];

  for (const row of rows) {
    const id = row.acpSessionId;
    if (id == null || id.length === 0) {
      singletons.push(row);
      continue;
    }
    const list = bySession.get(id);
    if (list) list.push(row);
    else bySession.set(id, [row]);
  }

  const groups: SessionListGroup[] = [];

  for (const [acpSessionId, spawns] of bySession) {
    const representative = pickRepresentative(spawns);
    const startedAt = spawns.reduce(
      (min, s) => (s.startedAt < min ? s.startedAt : min),
      spawns[0]!.startedAt,
    );
    const lastActivityAt = spawns.reduce(
      (max, s) => (s.lastActivityAt > max ? s.lastActivityAt : max),
      spawns[0]!.lastActivityAt,
    );
    groups.push({
      kind: "session",
      acpSessionId,
      spawns: [...spawns].sort((a, b) =>
        a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
      ),
      representative,
      startedAt,
      lastActivityAt,
      durationMs: Math.max(0, Date.parse(lastActivityAt) - Date.parse(startedAt)),
      status: aggregateStatus(spawns),
      promptCount: spawns.reduce((n, s) => n + s.promptCount, 0),
      toolCallCount: spawns.reduce((n, s) => n + (s.toolCallCount ?? 0), 0),
      route: representative.route,
      model: representative.model,
      cwd: representative.cwd,
    });
  }

  for (const spawn of singletons) {
    groups.push({ kind: "singleton", spawn });
  }

  groups.sort((a, b) => {
    const aStart = a.kind === "session" ? a.startedAt : a.spawn.startedAt;
    const bStart = b.kind === "session" ? b.startedAt : b.spawn.startedAt;
    return aStart < bStart ? 1 : aStart > bStart ? -1 : 0;
  });

  return groups;
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `bun test tests/acp-session-list-group.test.ts`

Expected: all pass

- [ ] **Step 5: Commit** (if the user asked for commits during execution; otherwise skip until asked)

```bash
git add src/acp/session-list-group.ts tests/acp-session-list-group.test.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): add session list grouping helper

Group conversation summaries by acpSessionId for the Observatory list UI.
EOF
)"
```

---

### Task 2: API endpoint + list UI

**Files:**
- Modify: `src/dashboard/acp-routes.ts`
- Modify: `tests/acp-dashboard.test.ts`
- Modify: `public/list.js`
- Modify: `public/styles.css`
- Modify: `public/index.html` (filter placeholder / count only)
- Modify: `docs/acp-bridge.md` (API row + layout note)
- Modify: `README.md` (API table row)
- Consumes: `groupConversationsForList` from Task 1
- Produces: `GET /api/acp-conversation-sessions` + grouped list UX

**JSON shape** (array of groups, same order as helper):

```ts
// session group
{
  kind: "session",
  acpSessionId: string,
  representativeBridgePid: number,
  startedAt, lastActivityAt, durationMs, status,
  promptCount, toolCallCount, route, model, cwd,
  spawns: ConversationSummary[]  // already overlayed / live-status
}
// singleton
{
  kind: "singleton",
  spawn: ConversationSummary
}
```

- [ ] **Step 1: Write failing dashboard test for the new endpoint**

In `tests/acp-dashboard.test.ts`, append a test that appends two `process_start`+prompt conversations sharing the same `acpSessionId` via events (or reuse existing fixture patterns), then:

```ts
test("GET /api/acp-conversation-sessions groups by acpSessionId", async () => {
  // Arrange two ended/live summaries with the same sessionHints ACP id
  // (follow existing conversation-list test patterns in this file).
  const body = await (await app.request("http://127.0.0.1/api/acp-conversation-sessions")).json();
  expect(Array.isArray(body)).toBe(true);
  const sessionGroups = body.filter((g: { kind: string }) => g.kind === "session");
  // Assert at least one session group has spawns.length >= 2 when fixtures share an id,
  // OR with explicit store.summaries stubbing if easier in this harness.
});
```

Prefer constructing events so two bridgePids share one ACP session id (set `sessionHints` on rpc events the same way other tests do). If that is too heavy, call the route handler after seeding `store` with summaries that already include `acpSessionId` — match whatever the existing `GET /api/acp-conversations` test does.

Expected before implementation: 404 or empty miss.

- [ ] **Step 2: Implement `GET /api/acp-conversation-sessions`**

In `src/dashboard/acp-routes.ts`, register **before** `/:bridgePid` routes if path could collide (path is distinct — register near the flat list GET):

```ts
import { groupConversationsForList } from "../acp/session-list-group";

app.get("/api/acp-conversation-sessions", (c) => {
  const stored = loadSessionModels(config.eventsPath);
  const rows = store.summaries().map((row) => withLiveStatus(overlayStoredModel(row, stored)));
  const groups = groupConversationsForList(rows).map((g) => {
    if (g.kind === "singleton") return g;
    const { representative, ...rest } = g;
    return {
      ...rest,
      representativeBridgePid: representative.bridgePid,
    };
  });
  return c.json(groups);
});
```

Do **not** change the flat `GET /api/acp-conversations` handler.

- [ ] **Step 3: Run dashboard + unit tests**

Run: `bun test tests/acp-session-list-group.test.ts tests/acp-dashboard.test.ts`

Expected: pass

- [ ] **Step 4: Add CSS** (same as previous plan CSS block for `.session-expand`, `.session-child`, etc.)

- [ ] **Step 5: Rewrite `public/list.js` to fetch `/api/acp-conversation-sessions`**

- Fetch grouped API into `acpSessionGroups` (replace flat `acpConversations` for list rendering)
- **Do not** port `groupConversationsForList` / `pickRepresentative` / `aggregateStatus` into JS
- Keep expand `sessionStorage`, filter, count, parent/child click behavior from the design
- Parent `data-pid` = `representativeBridgePid`
- Child rows from `g.spawns`; singleton from `g.spawn`
- Search text helpers stay in JS (presentation only)

Filter / expand / click behavior matches the design spec (auto-expand on child hit; counts as `X sessions (Y spawns)`).

- [ ] **Step 6: Update `public/index.html` placeholder, `docs/acp-bridge.md`, `README.md`**

- Placeholder: `Filter sessions (route · model · project · session id · status)…`
- Docs: list groups by `acpSessionId` via `GET /api/acp-conversation-sessions`; detail still by `bridgePid`
- README API table: add the new GET row

- [ ] **Step 7: Full test suite + manual smoke**

Run: `bun test`

Manual: hard-refresh Observatory; shared Cursor session → one parent + expandable spawns.

- [ ] **Step 8: Commit** (when executing under SDD, commit)

```bash
git add src/dashboard/acp-routes.ts tests/acp-dashboard.test.ts public/list.js public/styles.css public/index.html docs/acp-bridge.md README.md
git commit -m "$(cat <<'EOF'
feat(dashboard): group conversation list by ACP session id

Expose GET /api/acp-conversation-sessions and render expandable session rows so resume spawns are not mistaken for separate sessions.
EOF
)"
```

---

## Spec coverage checklist

| Spec item | Task |
|-----------|------|
| Group by `acpSessionId` | Task 1 + 2 |
| Singleton without id | Task 1 |
| Representative live-prefer | Task 1 + 2 |
| Parent aggregates | Task 1 + 2 |
| Expand + sessionStorage | Task 2 |
| Filter + auto-expand | Task 2 |
| Count `sessions (spawns)` | Task 2 |
| Click parent/child/expand | Task 2 |
| Single TS source (no JS port) | Task 2 via `/api/acp-conversation-sessions` |
| Flat list API unchanged | Task 2 |
| Unit test helper | Task 1 |

## Placeholder scan

None.
