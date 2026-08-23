import { describe, expect, test } from "bun:test";
import { handleQoderExtensionLine, parseQoderExtensionLine } from "../src/acp/qoder-shim";

describe("parseQoderExtensionLine", () => {
  test("detects qoder/* methods", () => {
    const msg = parseQoderExtensionLine(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "qoder/example", params: {} }),
    );
    expect(msg?.method).toBe("qoder/example");
  });

  test("ignores standard ACP methods", () => {
    expect(
      parseQoderExtensionLine(
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} }),
      ),
    ).toBeNull();
  });
});

describe("handleQoderExtensionLine", () => {
  test("acks blocking qoder/* and suppresses", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "qoder/example",
      params: {},
    });
    const action = handleQoderExtensionLine(line, "sess-1");
    expect(action).not.toBeNull();
    expect(action!.suppressOriginal).toBe(true);
    expect(action!.clientNotifications).toEqual([]);
    expect(JSON.parse(action!.agentReplies[0]!)).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: { outcome: { outcome: "accepted" } },
    });
  });

  test("suppresses notification-shaped qoder/* without reply", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "qoder/example",
      params: {},
    });
    const action = handleQoderExtensionLine(line, null);
    expect(action!.suppressOriginal).toBe(true);
    expect(action!.agentReplies).toEqual([]);
  });
});
