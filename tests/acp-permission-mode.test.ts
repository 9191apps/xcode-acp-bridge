import { describe, expect, test } from "bun:test";
import { autoApprovePermissionLine, pickAllowOption } from "../src/acp/permission-mode";

function requestLine(params: unknown, id: unknown = 7, method = "session/request_permission"): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

describe("pickAllowOption", () => {
  test("prefers allow_always over allow_once so the agent stops asking", () => {
    const picked = pickAllowOption([
      { optionId: "reject-once", kind: "reject_once" },
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "allow-always", kind: "allow_always" },
    ]);
    expect(picked).toEqual({ optionId: "allow-always", kind: "allow_always" });
  });

  test("falls back to allow_once when that is the only grant", () => {
    const picked = pickAllowOption([
      { optionId: "reject-once", kind: "reject_once" },
      { optionId: "allow-once", kind: "allow_once" },
    ]);
    expect(picked).toEqual({ optionId: "allow-once", kind: "allow_once" });
  });

  test("matches non-spec option ids when kind is missing", () => {
    expect(pickAllowOption([{ optionId: "reject-once" }, { optionId: "allow-once" }])).toEqual({
      optionId: "allow-once",
      kind: null,
    });
    expect(pickAllowOption([{ optionId: "approve" }])).toEqual({ optionId: "approve", kind: null });
    expect(pickAllowOption([{ optionId: "Allow-Once", name: "x" }])).toEqual({
      optionId: "Allow-Once",
      kind: null,
    });
  });

  test("returns null for reject-only options", () => {
    expect(
      pickAllowOption([
        { optionId: "reject-once", kind: "reject_once" },
        { optionId: "reject-always", kind: "reject_always" },
      ]),
    ).toBeNull();
  });

  test("returns null for missing or malformed option lists", () => {
    expect(pickAllowOption(undefined)).toBeNull();
    expect(pickAllowOption([])).toBeNull();
    expect(pickAllowOption("allow")).toBeNull();
    expect(pickAllowOption([{ name: "no id" }, null, 5])).toBeNull();
  });
});

describe("autoApprovePermissionLine", () => {
  test("builds a selected-allow reply and keeps session id for context", () => {
    const approval = autoApprovePermissionLine(
      requestLine({
        sessionId: "sess-1",
        toolCall: { toolCallId: "call-1", title: "Run tests" },
        options: [
          { optionId: "reject-once", kind: "reject_once" },
          { optionId: "allow-once", kind: "allow_once" },
        ],
      }),
    );
    expect(approval).not.toBeNull();
    expect(approval!.optionId).toBe("allow-once");
    expect(approval!.optionKind).toBe("allow_once");
    expect(approval!.sessionId).toBe("sess-1");
    expect(JSON.parse(approval!.reply)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });
  });

  test("supports string request ids", () => {
    const approval = autoApprovePermissionLine(
      requestLine({ sessionId: "s", options: [{ optionId: "allow-always", kind: "allow_always" }] }, "perm-1"),
    );
    expect(JSON.parse(approval!.reply).id).toBe("perm-1");
  });

  test("ignores other methods", () => {
    expect(
      autoApprovePermissionLine(
        requestLine({ options: [{ optionId: "allow-once", kind: "allow_once" }] }, 3, "session/update"),
      ),
    ).toBeNull();
  });

  test("ignores a request with no id (nothing to answer)", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/request_permission",
      params: { options: [{ optionId: "allow-once", kind: "allow_once" }] },
    });
    expect(autoApprovePermissionLine(line)).toBeNull();
  });

  test("fails open on reject-only options, malformed params, and non-JSON", () => {
    const rejectOnly = requestLine({
      options: [{ optionId: "reject-once", kind: "reject_once" }],
    });
    expect(autoApprovePermissionLine(rejectOnly)).toBeNull();
    expect(autoApprovePermissionLine(requestLine({ sessionId: "s" }))).toBeNull();
    expect(autoApprovePermissionLine(requestLine(null))).toBeNull();
    expect(autoApprovePermissionLine("{not json")).toBeNull();
    expect(autoApprovePermissionLine(JSON.stringify([1, 2]))).toBeNull();
  });
});
