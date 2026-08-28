import { describe, expect, test } from "bun:test";
import { disconnectAcpBridge, looksLikeAcpBridge } from "../src/acp/disconnect";

describe("looksLikeAcpBridge", () => {
  test("accepts the packaged MacOS sidecar", () => {
    expect(
      looksLikeAcpBridge("/Applications/ACP Bridge.app/Contents/MacOS/acp-bridge"),
    ).toBe(true);
  });

  test("accepts bun running the repo entrypoint", () => {
    expect(looksLikeAcpBridge("bun /Users/dev/xcode-acp-bridge/src/acp-bridge.ts")).toBe(true);
  });

  test("rejects acp-serve and resume helpers", () => {
    expect(looksLikeAcpBridge("/Applications/ACP Bridge.app/Contents/MacOS/acp-serve")).toBe(false);
    expect(looksLikeAcpBridge("bun /Users/dev/xcode-acp-bridge/src/acp/cursor-acp-resume.ts")).toBe(
      false,
    );
    expect(looksLikeAcpBridge("/Applications/ACP Bridge.app/Contents/MacOS/ACPBridge")).toBe(false);
  });

  test("rejects empty args", () => {
    expect(looksLikeAcpBridge("")).toBe(false);
    expect(looksLikeAcpBridge("   ")).toBe(false);
  });
});

describe("disconnectAcpBridge", () => {
  test("409s when the pid is not running", () => {
    const signaled: number[] = [];
    const result = disconnectAcpBridge(42, {
      alive: () => false,
      argsFor: () => "/MacOS/acp-bridge",
      signal: (pid) => signaled.push(pid),
    });
    expect(result).toEqual({ ok: false, status: 409, error: "not live" });
    expect(signaled).toEqual([]);
  });

  test("409s when the pid is not an acp-bridge process", () => {
    const signaled: number[] = [];
    const result = disconnectAcpBridge(99, {
      alive: () => true,
      argsFor: () => "/MacOS/acp-serve",
      signal: (pid) => signaled.push(pid),
    });
    expect(result).toEqual({ ok: false, status: 409, error: "not an acp-bridge process" });
    expect(signaled).toEqual([]);
  });

  test("sends SIGTERM to a live acp-bridge", () => {
    const signaled: Array<[number, NodeJS.Signals]> = [];
    const result = disconnectAcpBridge(4242, {
      alive: () => true,
      argsFor: () => "/Applications/ACP Bridge.app/Contents/MacOS/acp-bridge",
      signal: (pid, sig) => signaled.push([pid, sig]),
    });
    expect(result).toEqual({ ok: true, bridgePid: 4242 });
    expect(signaled).toEqual([[4242, "SIGTERM"]]);
  });

  test("treats ESRCH after the alive check as success", () => {
    const err = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    const result = disconnectAcpBridge(7, {
      alive: () => true,
      argsFor: () => "bun src/acp-bridge.ts",
      signal: () => {
        throw err;
      },
    });
    expect(result).toEqual({ ok: true, bridgePid: 7 });
  });

  test("500s when signaling is refused", () => {
    const err = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    const result = disconnectAcpBridge(7, {
      alive: () => true,
      argsFor: () => "bun src/acp-bridge.ts",
      signal: () => {
        throw err;
      },
    });
    expect(result).toEqual({ ok: false, status: 500, error: "signal failed" });
  });
});
