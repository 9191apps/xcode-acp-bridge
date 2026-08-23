import { describe, expect, test } from "bun:test";
import type { AcpEvent } from "../src/acp/types";
import { conversationDetail, summarizeConversations } from "../src/acp/conversations";

function ev(over: Partial<AcpEvent> & Pick<AcpEvent, "id" | "ts" | "kind">): AcpEvent {
  return {
    bridgePid: 10,
    backendPid: 11,
    dir: null,
    rpcId: null,
    method: null,
    sessionHints: [],
    raw: "",
    truncated: false,
    parseError: null,
    ...over,
  };
}

const sessionNewRaw = JSON.stringify({
  jsonrpc: "2.0",
  id: "1",
  method: "session/new",
  params: {
    cwd: "/Users/me/SwiftMark",
    mcpServers: [{ env: { MCP_XCODE_SESSION_ID: "MCP-1" } }],
  },
});

describe("summarizeConversations", () => {
  test("groups by bridgePid and hydrates identities from raw", () => {
    const events: AcpEvent[] = [
      ev({
        id: "a",
        ts: "2026-08-15T00:00:00.000Z",
        kind: "process_start",
        bridgePid: 1,
        route: "opencode",
        raw: JSON.stringify({ route: "opencode", command: "/bin/x", args: [] }),
      }),
      ev({
        id: "b",
        ts: "2026-08-15T00:00:01.000Z",
        kind: "rpc",
        bridgePid: 1,
        dir: "c2a",
        method: "session/new",
        rpcId: "1",
        raw: sessionNewRaw,
      }),
      ev({
        id: "c",
        ts: "2026-08-15T00:00:02.000Z",
        kind: "rpc",
        bridgePid: 1,
        dir: "a2c",
        rpcId: "1",
        sessionHints: ["ses_aaa"],
        raw: JSON.stringify({ jsonrpc: "2.0", id: "1", result: { sessionId: "ses_aaa" } }),
      }),
      ev({
        id: "d",
        ts: "2026-08-15T00:00:03.000Z",
        kind: "rpc",
        bridgePid: 1,
        dir: "c2a",
        method: "session/prompt",
        raw: "{}",
      }),
      ev({
        id: "e",
        ts: "2026-08-15T00:01:00.000Z",
        kind: "process_start",
        bridgePid: 2,
        route: "other",
        raw: JSON.stringify({ route: "other" }),
      }),
    ];
    const rows = summarizeConversations(events);
    expect(rows.map((r) => r.bridgePid)).toEqual([2, 1]);
    expect(rows[1].cwd).toBe("/Users/me/SwiftMark");
    expect(rows[1].mcpXcodeSessionId).toBe("MCP-1");
    expect(rows[1].acpSessionId).toBe("ses_aaa");
    expect(rows[1].route).toBe("opencode");
    expect(rows[1].promptCount).toBe(1);
    expect(rows[1].status).toBe("live");
    expect(rows[0].status).toBe("live");
  });

  test("summary model is the last observed modelCurrent", () => {
    const events = [
      ev({ id: "1", ts: "t1", kind: "rpc", dir: "a2c", modelCurrent: "m-a", raw: "{}" }),
      ev({ id: "2", ts: "t2", kind: "rpc", dir: "a2c", modelCurrent: "m-b", raw: "{}" }),
      ev({ id: "3", ts: "t3", kind: "rpc", dir: "c2a", raw: "{}" }),
    ];
    const rows = summarizeConversations(events);
    expect(rows[0].model).toBe("m-b");
  });

  test("hydrates modelCurrent from raw when the field is missing", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        sessionId: "s",
        configOptions: [{ id: "model", category: "model", currentValue: "m-x", options: [] }],
      },
    });
    const rows = summarizeConversations([ev({ id: "1", ts: "t1", kind: "rpc", dir: "a2c", raw })]);
    expect(rows[0].model).toBe("m-x");
  });
});

describe("conversationDetail timeline", () => {
  test("collapses message chunks and folds tool_call_update", () => {
    const pid = 10;
    const events: AcpEvent[] = [
      ev({ id: "0", ts: "t0", kind: "process_start", route: "opencode", raw: '{"route":"opencode"}' }),
      ev({
        id: "1",
        ts: "t1",
        kind: "rpc",
        method: "session/prompt",
        dir: "c2a",
        raw: "{}",
      }),
      ev({
        id: "2",
        ts: "t2",
        kind: "rpc",
        method: "session/update",
        dir: "a2c",
        sessionUpdate: "tool_call",
        toolName: "XcodeRead",
        raw: "{}",
      }),
      ev({
        id: "3",
        ts: "t3",
        kind: "rpc",
        method: "session/update",
        dir: "a2c",
        sessionUpdate: "tool_call_update",
        toolName: "XcodeRead",
        raw: "{}",
      }),
      ev({
        id: "4",
        ts: "t4",
        kind: "rpc",
        method: "session/update",
        dir: "a2c",
        sessionUpdate: "agent_message_chunk",
        raw: "{}",
      }),
      ev({
        id: "5",
        ts: "t5",
        kind: "rpc",
        method: "session/update",
        dir: "a2c",
        sessionUpdate: "agent_message_chunk",
        raw: "{}",
      }),
      ev({ id: "6", ts: "t6", kind: "process_end", raw: "" }),
    ];
    const detail = conversationDetail(events, pid);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe("ended");
    expect(detail!.toolCallCount).toBe(1);
    const types = detail!.timeline.map((i) => i.type);
    expect(types).toEqual(["process", "rpc", "tool_call", "chunks", "process"]);
    const tool = detail!.timeline.find((i) => i.type === "tool_call");
    expect(tool).toMatchObject({ type: "tool_call", name: "XcodeRead", updateCount: 1 });
    const chunks = detail!.timeline.find((i) => i.type === "chunks");
    expect(chunks).toMatchObject({ type: "chunks", count: 2, update: "agent_message_chunk" });
  });

  test("chunks aggregate text from content.text", () => {
    const chunk = (id: string, text: string) =>
      ev({
        id,
        ts: `t-${id}`,
        kind: "rpc",
        method: "session/update",
        dir: "a2c",
        sessionUpdate: "agent_message_chunk",
        raw: JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          },
        }),
      });
    const detail = conversationDetail(
      [
        chunk("10-1", "Hello"),
        {
          ...chunk("10-2", ", "),
          ts: "2026-08-15T00:00:00.100Z",
        },
        {
          ...chunk("10-3", "world"),
          ts: "2026-08-15T00:00:00.250Z",
        },
      ].map((e, i) =>
        i === 0 ? { ...e, ts: "2026-08-15T00:00:00.000Z" } : e,
      ),
      10,
    );
    expect(detail!.timeline).toHaveLength(1);
    expect(detail!.timeline[0]).toMatchObject({
      type: "chunks",
      count: 3,
      update: "agent_message_chunk",
      text: "Hello, world",
      durationMs: 250,
    });
  });

  test("conversation and rpc durations", () => {
    const events: AcpEvent[] = [
      ev({
        id: "10-1",
        ts: "2026-08-15T00:00:00.000Z",
        kind: "process_start",
        route: "opencode",
        raw: JSON.stringify({ route: "opencode" }),
      }),
      ev({
        id: "10-2",
        ts: "2026-08-15T00:00:01.000Z",
        kind: "rpc",
        method: "session/prompt",
        dir: "c2a",
        rpcId: "req-1",
        raw: "{}",
      }),
      ev({
        id: "10-3",
        ts: "2026-08-15T00:00:03.500Z",
        kind: "rpc",
        method: "rpc",
        dir: "a2c",
        rpcId: "req-1",
        raw: "{}",
      }),
      ev({
        id: "10-4",
        ts: "2026-08-15T00:00:05.000Z",
        kind: "process_end",
        raw: "",
      }),
    ];
    const detail = conversationDetail(events, 10);
    // Active span ignores idle process_end tail: last activity is 03.500s.
    expect(detail!.durationMs).toBe(3500);
    expect(detail!.lastActivityAt).toBe("2026-08-15T00:00:03.500Z");
    expect(detail!.timeline[1]).toMatchObject({ type: "rpc", method: "session/prompt", gapMs: 1000 });
    expect(detail!.timeline[2]).toMatchObject({
      type: "rpc",
      dir: "a2c",
      durationMs: 2500,
      gapMs: 2500,
    });
  });

  test("unknown bridgePid returns null", () => {
    expect(conversationDetail([], 99)).toBeNull();
  });

  test("filters by bridgePid before hydrating", () => {
    const events: AcpEvent[] = [
      ev({
        id: "99-1",
        ts: "t0",
        kind: "process_start",
        bridgePid: 99,
        route: "other",
        raw: JSON.stringify({ route: "other" }),
      }),
      ev({
        id: "10-1",
        ts: "t0",
        kind: "process_start",
        route: "opencode",
        raw: JSON.stringify({ route: "opencode" }),
      }),
    ];
    const detail = conversationDetail(events, 10);
    expect(detail).not.toBeNull();
    expect(detail!.eventCount).toBe(1);
    expect(detail!.route).toBe("opencode");
    expect(detail!.bridgePid).toBe(10);
  });

  test("same-millisecond tool_call then tool_call_update folds by numeric seq", () => {
    const ts = "2026-08-15T00:00:00.000Z";
    const events: AcpEvent[] = [
      ev({
        id: "10-9",
        ts,
        kind: "rpc",
        method: "session/update",
        dir: "a2c",
        sessionUpdate: "tool_call",
        toolName: "XcodeRead",
        raw: "{}",
      }),
      ev({
        id: "10-10",
        ts,
        kind: "rpc",
        method: "session/update",
        dir: "a2c",
        sessionUpdate: "tool_call_update",
        toolName: "XcodeRead",
        raw: "{}",
      }),
    ];
    const detail = conversationDetail(events, 10);
    expect(detail).not.toBeNull();
    expect(detail!.timeline).toHaveLength(1);
    expect(detail!.timeline[0]).toMatchObject({
      type: "tool_call",
      name: "XcodeRead",
      updateCount: 1,
    });
  });

  test("timeline items include raw from the primary event", () => {
    const events: AcpEvent[] = [
      ev({
        id: "10-1",
        ts: "t0",
        kind: "process_start",
        route: "opencode",
        raw: '{"route":"opencode"}',
      }),
      ev({
        id: "10-2",
        ts: "t1",
        kind: "rpc",
        method: "session/prompt",
        dir: "c2a",
        raw: '{"prompt":true}',
      }),
    ];
    const detail = conversationDetail(events, 10);
    expect(detail!.timeline[0]).toMatchObject({
      type: "process",
      eventId: "10-1",
      raw: '{"route":"opencode"}',
    });
    expect(detail!.timeline[1]).toMatchObject({
      type: "rpc",
      eventId: "10-2",
      raw: '{"prompt":true}',
    });
  });
});
