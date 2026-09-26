import { describe, expect, test, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runBridge } from "../src/acp/run-bridge";
import {
  rewriteXcodeMcpServers,
  xcodeMcpProxyPrefix,
  MCP_PROXY_ARG,
} from "../src/acp/mcp-proxy";

const PREFIX = ["/Applications/ACP Bridge.app/Contents/MacOS/acp-bridge"];

const xcodeServer = {
  name: "xcode-tools",
  command: "xcrun",
  args: ["mcpbridge"],
  env: [
    { name: "MCP_XCODE_PID", value: "123" },
    { name: "MCP_XCODE_SESSION_ID", value: "sess-1" },
  ],
};

function sessionNew(mcpServers: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "req-1",
    method: "session/new",
    params: { cwd: "/tmp/proj", mcpServers },
  });
}

describe("rewriteXcodeMcpServers", () => {
  test("rewrites xcrun mcpbridge entry through the proxy, preserving env", () => {
    const out = JSON.parse(rewriteXcodeMcpServers(sessionNew([xcodeServer]), PREFIX));
    expect(out.id).toBe("req-1");
    expect(out.method).toBe("session/new");
    expect(out.params.cwd).toBe("/tmp/proj");
    const srv = out.params.mcpServers[0];
    expect(srv.command).toBe(PREFIX[0]);
    expect(srv.args).toEqual([MCP_PROXY_ARG, "xcrun", "mcpbridge"]);
    expect(srv.env).toEqual(xcodeServer.env);
    expect(srv.name).toBe("xcode-tools");
  });

  test("rewrites a direct mcpbridge command too", () => {
    const entry = { command: "/usr/bin/mcpbridge", args: [] };
    const out = JSON.parse(rewriteXcodeMcpServers(sessionNew([entry]), PREFIX));
    expect(out.params.mcpServers[0].command).toBe(PREFIX[0]);
    expect(out.params.mcpServers[0].args).toEqual([MCP_PROXY_ARG, "/usr/bin/mcpbridge"]);
  });

  test("dev-mode prefix keeps the script entry in args", () => {
    const prefix = ["/opt/homebrew/bin/bun", "/repo/src/acp-bridge.ts"];
    const out = JSON.parse(rewriteXcodeMcpServers(sessionNew([xcodeServer]), prefix));
    expect(out.params.mcpServers[0].command).toBe(prefix[0]);
    expect(out.params.mcpServers[0].args).toEqual([
      "/repo/src/acp-bridge.ts",
      MCP_PROXY_ARG,
      "xcrun",
      "mcpbridge",
    ]);
  });

  test("non-Xcode servers and sibling fields pass through untouched", () => {
    const other = { name: "filesystem", command: "mcp-fs", args: ["--root", "/"] };
    const line = sessionNew([other, xcodeServer]);
    const out = JSON.parse(rewriteXcodeMcpServers(line, PREFIX));
    expect(out.params.mcpServers[0]).toEqual(other);
    expect(out.params.mcpServers[1].command).toBe(PREFIX[0]);
  });

  test("session/load and session/resume are rewritten as well", () => {
    for (const method of ["session/load", "session/resume"]) {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method,
        params: { sessionId: "s", mcpServers: [xcodeServer] },
      });
      const out = JSON.parse(rewriteXcodeMcpServers(line, PREFIX));
      expect(out.params.mcpServers[0].command).toBe(PREFIX[0]);
    }
  });

  test("non-matching payloads pass through verbatim", () => {
    const cases = [
      "{bad json",
      sessionNew([]),
      sessionNew([{ command: "other-tool", args: [] }]),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { mcpServers: [xcodeServer] } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} }),
    ];
    for (const line of cases) {
      expect(rewriteXcodeMcpServers(line, PREFIX)).toBe(line);
    }
  });
});

describe("xcodeMcpProxyPrefix", () => {
  test("compiled sidecar re-enters its own binary", () => {
    expect(
      xcodeMcpProxyPrefix("/Applications/ACP Bridge.app/Contents/MacOS/acp-bridge", "/$bunfs/root/x"),
    ).toEqual(["/Applications/ACP Bridge.app/Contents/MacOS/acp-bridge"]);
  });

  test("dev checkout re-enters via bun + script", () => {
    expect(xcodeMcpProxyPrefix("/opt/homebrew/bin/bun", "/repo/src/acp-bridge.ts")).toEqual([
      "/opt/homebrew/bin/bun",
      "/repo/src/acp-bridge.ts",
    ]);
  });
});

describe("runMcpProxy (e2e via acp-bridge.ts mcp-proxy cat)", () => {
  test("pipes bytes both ways and exits with the child", async () => {
    const entry = path.join(import.meta.dir, "../src/acp-bridge.ts");
    const proc = Bun.spawn([process.execPath, entry, MCP_PROXY_ARG, "cat"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write("hello-mcp\n");
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(out).toBe("hello-mcp\n");
    expect(code).toBe(0);
  });

  test("missing command exits 2", async () => {
    const entry = path.join(import.meta.dir, "../src/acp-bridge.ts");
    const proc = Bun.spawn([process.execPath, entry, MCP_PROXY_ARG], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).toBe(2);
  });

  test("forwards a full MCP session (initialize, tools/list, tools/call)", async () => {
    const entry = path.join(import.meta.dir, "../src/acp-bridge.ts");
    const fixture = path.join(import.meta.dir, "fixtures/mcp-echo-server.ts");
    const proc = Bun.spawn([process.execPath, entry, MCP_PROXY_ARG, process.execPath, fixture], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "pong" } } },
    ];
    proc.stdin.write(`${requests.map((r) => JSON.stringify(r)).join("\n")}\n`);
    proc.stdin.end();

    const responses = (await new Response(proc.stdout).text())
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    expect(await proc.exited).toBe(0);
    expect(responses.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(responses[0].result.serverInfo.name).toBe("fixture-mcp");
    expect(responses[1].result.tools.map((t: { name: string }) => t.name)).toEqual(["echo"]);
    expect(responses[2].result.content[0].text).toBe("pong");
  });
});

describe("runBridge wiring", () => {
  const dir = path.join(import.meta.dir, ".tmp-acp-mcp-proxy");
  const eventsPath = path.join(dir, "acp-events.jsonl");
  const fixture = path.join(import.meta.dir, "fixtures/acp-fake-agent.ts");

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("forwarded session/new carries the mcp-proxy rewrite", async () => {
    await fs.mkdir(dir, { recursive: true });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin,
      stdout,
    });
    stdin.write(`${sessionNew([xcodeServer])}\n`);
    await Bun.sleep(200);
    stdin.end();
    await running;

    const shardDir = path.join(dir, "acp-events");
    const names = (await fs.readdir(shardDir)).filter((n) => n.endsWith(".jsonl"));
    const events: Array<Record<string, unknown>> = [];
    for (const name of names) {
      for (const line of (await fs.readFile(path.join(shardDir, name), "utf8")).split("\n")) {
        if (line.trim()) events.push(JSON.parse(line));
      }
    }
    const newReq = events.find((e) => e.dir === "c2a" && e.method === "session/new");
    expect(newReq).toBeTruthy();
    const raw = JSON.parse(newReq!.raw as string);
    expect(raw.params.mcpServers[0].args).toContain(MCP_PROXY_ARG);
    expect(raw.params.mcpServers[0].env).toEqual(xcodeServer.env);
  });
});
