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
