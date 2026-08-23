import { describe, expect, test } from "bun:test";
import { extractRpcMeta, extractSessionHints, parseRpcLine } from "../src/acp/parse";

const sessionNew = {
  jsonrpc: "2.0",
  id: "uuid-1",
  method: "session/new",
  params: {
    cwd: "/Users/me/App",
    mcpServers: [
      {
        name: "xcode-tools",
        command: "xcrun",
        args: ["mcpbridge"],
        env: {
          MCP_XCODE_SESSION_ID: "68D39EB1-F780-484E-8656-26B8F291C390",
          MCP_XCODE_PID: "1",
        },
      },
    ],
  },
};

const sessionNewEnvArray = {
  jsonrpc: "2.0",
  id: "uuid-1",
  method: "session/new",
  params: {
    cwd: "/Users/me/App",
    mcpServers: [
      {
        name: "xcode-tools",
        command: "xcrun",
        args: ["mcpbridge"],
        env: [
          { name: "MCP_XCODE_PID", value: "46581" },
          { name: "MCP_XCODE_SESSION_ID", value: "68D39EB1-F780-484E-8656-26B8F291C390" },
        ],
      },
    ],
  },
};

describe("extractSessionHints", () => {
  test("finds sessionId in params and result", () => {
    const hints = extractSessionHints({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "sess-1" },
    });
    expect(hints).toContain("sess-1");
  });

  test("finds session_id nested", () => {
    const hints = extractSessionHints({
      method: "session/prompt",
      params: { session_id: "abc" },
    });
    expect(hints).toContain("abc");
  });

  test("dedupes", () => {
    const hints = extractSessionHints({ sessionId: "x", nested: { sessionId: "x" } });
    expect(hints.filter((h) => h === "x").length).toBe(1);
  });
});

describe("parseRpcLine configOptions", () => {
  test("session/new result exposes modelCurrent and modelCount", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        sessionId: "s1",
        configOptions: [
          {
            id: "model",
            category: "model",
            type: "select",
            currentValue: "m-a",
            options: [{ value: "m-a" }, { value: "m-b" }],
          },
          {
            id: "mode",
            category: "mode",
            type: "select",
            currentValue: "build",
            options: [{ value: "build" }, { value: "plan" }],
          },
        ],
      },
    });
    const parsed = parseRpcLine(line, 1024);
    expect(parsed.modelCurrent).toBe("m-a");
    expect(parsed.modelCount).toBe(2);
  });

  test("session/new result exposes modeCurrent and modeOptions", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        configOptions: [
          { id: "model", category: "model", type: "select", currentValue: "m-a", options: [] },
          {
            id: "mode",
            category: "mode",
            type: "select",
            currentValue: "build",
            options: [{ value: "build" }, { value: "plan" }],
          },
        ],
      },
    });
    const parsed = parseRpcLine(line, 1024);
    expect(parsed.modeCurrent).toBe("build");
    expect(parsed.modeOptions).toEqual(["build", "plan"]);
  });

  test("no mode configOption gives null modeCurrent and empty modeOptions", () => {
    const parsed = parseRpcLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), 1024);
    expect(parsed.modeCurrent).toBeNull();
    expect(parsed.modeOptions).toEqual([]);
  });

  test("falls back to id model when category is missing", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        configOptions: [{ id: "model", type: "select", currentValue: "m-x", options: [{ value: "m-x" }] }],
      },
    });
    expect(parseRpcLine(line, 1024).modelCurrent).toBe("m-x");
  });

  test("no configOptions gives nulls", () => {
    const parsed = parseRpcLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), 1024);
    expect(parsed.modelCurrent).toBeNull();
    expect(parsed.modelCount).toBeNull();
  });
});

describe("parseRpcLine", () => {
  test("extracts method and id", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    const parsed = parseRpcLine(line, 1024);
    expect(parsed.method).toBe("initialize");
    expect(parsed.rpcId).toBe(0);
    expect(parsed.parseError).toBeNull();
    expect(parsed.truncated).toBe(false);
    expect(parsed.raw).toBe(line);
  });

  test("invalid json sets parseError and keeps raw", () => {
    const parsed = parseRpcLine("{bad", 1024);
    expect(parsed.parseError).not.toBeNull();
    expect(parsed.raw).toBe("{bad");
    expect(parsed.method).toBeNull();
  });

  test("truncates stored raw over maxRawBytes", () => {
    const line = "x".repeat(50);
    const parsed = parseRpcLine(line, 10);
    expect(parsed.truncated).toBe(true);
    expect(parsed.raw.length).toBe(10);
  });
});

describe("extractRpcMeta", () => {
  test("reads cwd and MCP_XCODE_SESSION_ID from session/new", () => {
    const meta = extractRpcMeta(sessionNew);
    expect(meta.cwd).toBe("/Users/me/App");
    expect(meta.mcpXcodeSessionId).toBe("68D39EB1-F780-484E-8656-26B8F291C390");
    expect(meta.sessionHints).toContain("68D39EB1-F780-484E-8656-26B8F291C390");
  });

  test("reads MCP_XCODE_SESSION_ID from env name/value arrays", () => {
    const meta = extractRpcMeta(sessionNewEnvArray);
    expect(meta.cwd).toBe("/Users/me/App");
    expect(meta.mcpXcodeSessionId).toBe("68D39EB1-F780-484E-8656-26B8F291C390");
    expect(meta.sessionHints).toContain("68D39EB1-F780-484E-8656-26B8F291C390");
  });

  test("reads tool_call title as toolName", () => {
    const meta = extractRpcMeta({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses_abc",
        update: { sessionUpdate: "tool_call", title: "XcodeRead", kind: "read" },
      },
    });
    expect(meta.sessionUpdate).toBe("tool_call");
    expect(meta.toolName).toBe("XcodeRead");
    expect(meta.sessionHints).toContain("ses_abc");
  });

  test("toolName falls back to name then kind", () => {
    expect(
      extractRpcMeta({
        method: "session/update",
        params: { update: { sessionUpdate: "tool_call", name: "n", kind: "k" } },
      }).toolName,
    ).toBe("n");
    expect(
      extractRpcMeta({
        method: "session/update",
        params: { update: { sessionUpdate: "tool_call", kind: "k" } },
      }).toolName,
    ).toBe("k");
  });
});

describe("parseRpcLine meta", () => {
  test("copies extractRpcMeta onto parseRpcLine result", () => {
    const parsed = parseRpcLine(JSON.stringify(sessionNew), 10_000);
    expect(parsed.cwd).toBe("/Users/me/App");
    expect(parsed.mcpXcodeSessionId).toBe("68D39EB1-F780-484E-8656-26B8F291C390");
  });

  test("copies MCP_XCODE_SESSION_ID from env name/value arrays", () => {
    const parsed = parseRpcLine(JSON.stringify(sessionNewEnvArray), 10_000);
    expect(parsed.mcpXcodeSessionId).toBe("68D39EB1-F780-484E-8656-26B8F291C390");
  });
});
