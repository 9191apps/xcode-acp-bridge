import { describe, expect, test } from "bun:test";
import {
  formatCreatePlanMessage,
  handleCursorExtensionLine,
  parseCursorExtensionLine,
} from "../src/acp/cursor-shim";

describe("parseCursorExtensionLine", () => {
  test("detects cursor/* methods", () => {
    const msg = parseCursorExtensionLine(
      JSON.stringify({ jsonrpc: "2.0", id: 35, method: "cursor/create_plan", params: {} }),
    );
    expect(msg?.method).toBe("cursor/create_plan");
    expect(msg?.id).toBe(35);
  });

  test("ignores non-cursor methods", () => {
    expect(
      parseCursorExtensionLine(
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} }),
      ),
    ).toBeNull();
  });
});

describe("formatCreatePlanMessage", () => {
  test("formats name overview plan and todos", () => {
    const text = formatCreatePlanMessage({
      name: "First Screen",
      overview: "Ship fast first paint.",
      plan: "# Steps\n\n1. Do thing",
      todos: [
        { id: "1", content: "A", status: "completed" },
        { id: "2", content: "B", status: "pending" },
      ],
    });
    expect(text).toContain("## First Screen");
    expect(text).toContain("Ship fast first paint.");
    expect(text).toContain("# Steps");
    expect(text).toContain("- [x] A");
    expect(text).toContain("- [ ] B");
  });
});

describe("handleCursorExtensionLine", () => {
  test("create_plan acks nested accepted and emits message chunk", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 35,
      method: "cursor/create_plan",
      params: {
        name: "P",
        overview: "O",
        plan: "Body",
        todos: [{ id: "1", content: "t", status: "pending" }],
      },
    });
    const action = handleCursorExtensionLine(line, "sess-1");
    expect(action).not.toBeNull();
    expect(action!.suppressOriginal).toBe(true);
    expect(action!.agentReplies).toHaveLength(1);
    expect(JSON.parse(action!.agentReplies[0]!)).toEqual({
      jsonrpc: "2.0",
      id: 35,
      result: { outcome: { outcome: "accepted" } },
    });
    expect(action!.clientNotifications).toHaveLength(1);
    const note = JSON.parse(action!.clientNotifications[0]!);
    expect(note.method).toBe("session/update");
    expect(note.params.sessionId).toBe("sess-1");
    expect(note.params.update.sessionUpdate).toBe("agent_message_chunk");
    expect(note.params.update.content.text).toContain("## P");
    expect(note.params.update.content.text).toContain("Body");
  });

  test("update_todos with id is acked and not shown", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 26,
      method: "cursor/update_todos",
      params: {
        todos: [{ id: "1", content: "A", status: "in_progress" }],
        merge: true,
      },
    });
    const action = handleCursorExtensionLine(line, "sess-1");
    expect(action!.suppressOriginal).toBe(true);
    expect(action!.clientNotifications).toEqual([]);
    expect(JSON.parse(action!.agentReplies[0]!).result.outcome.outcome).toBe("accepted");
  });

  test("update_todos notification without id is swallowed", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "cursor/update_todos",
      params: { todos: [], merge: true },
    });
    const action = handleCursorExtensionLine(line, "sess-1");
    expect(action!.agentReplies).toEqual([]);
    expect(action!.suppressOriginal).toBe(true);
  });
});
