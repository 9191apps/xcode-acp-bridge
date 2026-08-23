import { describe, expect, test, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runBridge } from "../src/acp/run-bridge";
import { commandsDirFor, writeModelCommand } from "../src/acp/commands";
import { writeSessionModel } from "../src/acp/session-models";

const dir = path.join(import.meta.dir, ".tmp-acp-bridge");
const eventsPath = path.join(dir, "acp-events.jsonl");
const fixture = path.join(import.meta.dir, "fixtures/acp-fake-agent.ts");

// Events are stored as one JSONL file per conversation under
// <dir>/acp-events/. Read them all back in file order.
async function readEvents(): Promise<Array<Record<string, unknown>>> {
  const shardDir = path.join(dir, "acp-events");
  let names: string[];
  try {
    names = (await fs.readdir(shardDir)).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const text = await fs.readFile(path.join(shardDir, name), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) out.push(JSON.parse(trimmed) as Record<string, unknown>);
    }
  }
  return out;
}

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("runBridge", () => {
  test("forwards initialize and logs matching rpc ids", async () => {
    await fs.mkdir(dir, { recursive: true });
    const stdin = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c) => stdoutChunks.push(c as Buffer));

    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin,
      stdout,
    });

    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } })}\n`,
    );
    stdin.end();
    await running;

    const out = Buffer.concat(stdoutChunks).toString("utf8");
    expect(out).toContain("protocolVersion");
    const lines = (await readEvents());
    const initC2a = lines.find((e) => e.dir === "c2a" && e.method === "initialize");
    const initA2c = lines.find((e) => e.dir === "a2c" && e.rpcId === 0);
    expect(initC2a).toBeTruthy();
    expect(initA2c).toBeTruthy();
  });

  test("session/new result fills sessionHints", async () => {
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
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await readEvents());
    const a2c = lines.find((e) => e.dir === "a2c" && e.rpcId === 1);
    expect(a2c.sessionHints).toContain("sess-fixture");
  });

  test("invalid json is forwarded and parseError set", async () => {
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
    stdin.write("{bad\n");
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await readEvents());
    expect(lines.some((e) => e.parseError && e.raw.includes("{bad"))).toBe(true);
  });

  test("stdin end kills backend", async () => {
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
    await Bun.sleep(100);
    stdin.end();
    const { code } = await running;
    expect(code).toBe(0);
    const lines = (await readEvents());
    expect(lines.some((e) => e.kind === "process_end")).toBe(true);
  });

  test("oversized line truncated in store", async () => {
    await fs.mkdir(dir, { recursive: true });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture],
      eventsPath,
      maxRawBytes: 32,
      stdin,
      stdout,
    });
    const huge = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "initialize",
      params: { pad: "y".repeat(200) },
    });
    stdin.write(`${huge}\n`);
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await readEvents());
    const c2a = lines.find((e) => e.dir === "c2a" && e.method === "initialize");
    expect(c2a.truncated).toBe(true);
    expect(c2a.raw.length).toBe(32);
  });

  test("CLI pipe initialize returns protocolVersion", async () => {
    await fs.mkdir(dir, { recursive: true });
    const cfgPath = path.join(dir, "cfg.json");
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        defaultBackend: { command: process.execPath, args: [fixture] },
        eventsPath,
        maxRawBytes: 2 * 1024 * 1024,
      }),
    );
    const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/acp-bridge.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ACP_BRIDGE_CONFIG: cfgPath },
    });
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } })}\n`,
    );
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(out).toContain("protocolVersion");
    expect(code).toBe(0);
  });

  test("process_start raw includes route name", async () => {
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
      route: "opencode",
    });
    stdin.end();
    await running;
    const lines = (await readEvents());
    const start = lines.find((e) => e.kind === "process_start");
    expect(start.route).toBe("opencode");
    expect(JSON.parse(start.raw).route).toBe("opencode");
  });

  test("injects set_config_option after session/new and before prompt", async () => {
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
      pendingModel: "fixture/model-b",
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sess-fixture", prompt: [] } })}\n`,
    );
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await readEvents());
    const newIdx = lines.findIndex((e) => e.dir === "c2a" && e.method === "session/new");
    const injectIdx = lines.findIndex((e) => e.dir === "c2a" && e.method === "session/set_config_option");
    const promptIdx = lines.findIndex((e) => e.dir === "c2a" && e.method === "session/prompt");
    expect(injectIdx).toBeGreaterThan(newIdx);
    expect(promptIdx).toBeGreaterThan(injectIdx);
    expect(String(lines[injectIdx].rpcId)).toMatch(/^bridge-/);
    expect(JSON.parse(lines[injectIdx].raw).params.value).toBe("fixture/model-b");
    expect(JSON.parse(lines[injectIdx].raw).params.sessionId).toBe("sess-fixture");
  });

  test("injected response is logged but not forwarded to client", async () => {
    await fs.mkdir(dir, { recursive: true });
    const stdin = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c) => stdoutChunks.push(c as Buffer));
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin,
      stdout,
      pendingModel: "fixture/model-b",
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    stdin.end();
    await running;
    const out = Buffer.concat(stdoutChunks).toString("utf8");
    expect(out).toContain("sess-fixture");
    expect(out).not.toContain("bridge-");
    const lines = (await readEvents());
    const a2c = lines.find((e) => e.dir === "a2c" && String(e.rpcId).startsWith("bridge-"));
    expect(a2c).toBeTruthy();
    expect(JSON.parse(a2c.raw).result.configOptions[0].currentValue).toBe("fixture/model-b");
  });

  test("no injection when pendingModel is null", async () => {
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
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await readEvents());
    expect(lines.some((e) => e.method === "session/set_config_option")).toBe(false);
  });

  test("spawn-arg skips entry inject after session/new", async () => {
    await fs.mkdir(dir, { recursive: true });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture, "--model", "fixture/model-b"],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin,
      stdout,
      pendingModel: "fixture/model-b",
      modelApply: "spawn-arg",
      route: "cursor",
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sess-fixture", prompt: [] } })}\n`,
    );
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = await readEvents();
    const start = lines.find((e) => e.kind === "process_start");
    expect(JSON.parse(String(start!.raw)).args).toEqual([fixture, "--model", "fixture/model-b"]);
    expect(lines.some((e) => e.method === "session/set_config_option")).toBe(false);
  });

  test("spawn-arg still live-injects from command file after session/new", async () => {
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
      pendingModel: "fixture/model-a",
      modelApply: "spawn-arg",
      route: "cursor",
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    writeModelCommand(eventsPath, process.pid, "fixture/model-b");
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sess-fixture", prompt: [] } })}\n`,
    );
    await Bun.sleep(300);
    stdin.end();
    await running;
    const lines = await readEvents();
    expect(
      lines.some(
        (e) =>
          e.dir === "c2a" &&
          e.method === "session/set_config_option" &&
          String(e.rpcId).startsWith("bridge-") &&
          !String(e.rpcId).startsWith("bridge-live-"),
      ),
    ).toBe(false);
    const live = lines.filter(
      (e) =>
        e.dir === "c2a" &&
        e.method === "session/set_config_option" &&
        String(e.rpcId).startsWith("bridge-live-"),
    );
    expect(live).toHaveLength(1);
    expect(JSON.parse(String(live[0]!.raw)).params.value).toBe("fixture/model-b");
  });

  test("injection error is logged and session continues", async () => {
    await fs.mkdir(dir, { recursive: true });
    const stdin = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c) => stdoutChunks.push(c as Buffer));
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin,
      stdout,
      pendingModel: "fixture/unknown",
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sess-fixture", prompt: [] } })}\n`,
    );
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await readEvents());
    const errEvent = lines.find((e) => e.dir === "a2c" && String(e.rpcId).startsWith("bridge-"));
    expect(errEvent).toBeTruthy();
    expect(errEvent.raw).toContain("unknown config option or value");
    const out = Buffer.concat(stdoutChunks).toString("utf8");
    expect(out).toContain("end_turn");
    expect(out).not.toContain("bridge-");
  });

  test("CLI uses route state executable instead of default", async () => {
    await fs.mkdir(dir, { recursive: true });
    const cfgPath = path.join(dir, "cfg.json");
    const statePath = path.join(dir, "acp-route.json");
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        routes: {
          dead: { command: "/nonexistent-acp-backend-xyz", args: [] },
          fixture: { command: process.execPath, args: [fixture] },
        },
        defaultRoute: "dead",
        eventsPath,
        routeStatePath: statePath,
        maxRawBytes: 2 * 1024 * 1024,
      }),
    );
    await fs.writeFile(statePath, JSON.stringify({ route: "fixture" }));
    const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/acp-bridge.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ACP_BRIDGE_CONFIG: cfgPath },
    });
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } })}\n`,
    );
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(out).toContain("protocolVersion");
    expect(code).toBe(0);
    const lines = (await readEvents());
    expect(lines.find((e) => e.kind === "process_start").route).toBe("fixture");
  });

  test("CLI injects model from route state", async () => {
    await fs.mkdir(dir, { recursive: true });
    const cfgPath = path.join(dir, "cfg.json");
    const statePath = path.join(dir, "acp-route.json");
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        routes: { fixture: { command: process.execPath, args: [fixture] } },
        defaultRoute: "fixture",
        eventsPath,
        routeStatePath: statePath,
        maxRawBytes: 2 * 1024 * 1024,
      }),
    );
    await fs.writeFile(statePath, JSON.stringify({ route: "fixture", model: "fixture/model-b" }));
    const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/acp-bridge.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ACP_BRIDGE_CONFIG: cfgPath },
    });
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`,
    );
    await Bun.sleep(300);
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).not.toContain("bridge-");
    const lines = (await readEvents());
    const inject = lines.find((e) => e.dir === "c2a" && e.method === "session/set_config_option");
    expect(inject).toBeTruthy();
    expect(JSON.parse(inject.raw).params.value).toBe("fixture/model-b");
  });

  test("unknown session/set_mode modeId is rewritten to the backend default mode", async () => {
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
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/set_mode", params: { sessionId: "sess-fixture", modeId: "standard" } })}\n`,
    );
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await readEvents());
    const setMode = lines.find((e) => e.dir === "c2a" && e.method === "session/set_mode");
    expect(JSON.parse(setMode.raw).params.modeId).toBe("build");
    const response = lines.find((e) => e.dir === "a2c" && e.rpcId === 2);
    expect(response).toBeTruthy();
    expect(JSON.parse(response.raw).error).toBeUndefined();
    expect(JSON.parse(response.raw).result).toEqual({});
  });

  test("known session/set_mode modeId passes through unchanged", async () => {
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
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/set_mode", params: { sessionId: "sess-fixture", modeId: "plan" } })}\n`,
    );
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await readEvents());
    const setMode = lines.find((e) => e.dir === "c2a" && e.method === "session/set_mode");
    expect(JSON.parse(setMode.raw).params.modeId).toBe("plan");
    const response = lines.find((e) => e.dir === "a2c" && e.rpcId === 2);
    expect(JSON.parse(response.raw).result).toEqual({});
  });

  test("session/set_mode before modes are learned is forwarded unchanged", async () => {
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
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/set_mode", params: { sessionId: "sess-fixture", modeId: "standard" } })}\n`,
    );
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await readEvents());
    const setMode = lines.find((e) => e.dir === "c2a" && e.method === "session/set_mode");
    expect(JSON.parse(setMode.raw).params.modeId).toBe("standard");
    const response = lines.find((e) => e.dir === "a2c" && e.rpcId === 1);
    expect(JSON.parse(response.raw).error.message).toContain("mode not found: standard");
  });

  function liveInjects(lines: Array<Record<string, unknown>>) {
    return lines.filter(
      (e) =>
        e.dir === "c2a" &&
        e.method === "session/set_config_option" &&
        String(e.rpcId).startsWith("bridge-live-"),
    );
  }

  test("live command file after session/new injects set_config_option", async () => {
    await fs.mkdir(dir, { recursive: true });
    const stdin = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c) => stdoutChunks.push(c as Buffer));
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin,
      stdout,
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    writeModelCommand(eventsPath, process.pid, "fixture/model-b");
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sess-fixture", prompt: [] } })}\n`,
    );
    await Bun.sleep(300);
    stdin.end();
    await running;
    const lines = (await readEvents());
    const live = liveInjects(lines);
    expect(live).toHaveLength(1);
    expect(JSON.parse(live[0]!.raw).params.value).toBe("fixture/model-b");
    expect(JSON.parse(live[0]!.raw).params.sessionId).toBe("sess-fixture");
    const a2c = lines.find((e) => e.dir === "a2c" && String(e.rpcId).startsWith("bridge-live-"));
    expect(a2c).toBeTruthy();
    expect(a2c.modelCurrent).toBe("fixture/model-b");
    const out = Buffer.concat(stdoutChunks).toString("utf8");
    expect(out).toContain("end_turn");
    expect(out).not.toContain("bridge-live-");
  });

  test("command file written before session/new is applied once session id is known", async () => {
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
    await Bun.sleep(50);
    writeModelCommand(eventsPath, process.pid, "fixture/model-b");
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(300);
    stdin.end();
    await running;
    const lines = (await readEvents());
    const live = liveInjects(lines);
    expect(live).toHaveLength(1);
    expect(JSON.parse(live[0]!.raw).params.sessionId).toBe("sess-fixture");
    expect(JSON.parse(live[0]!.raw).params.value).toBe("fixture/model-b");
  });

  test("stale command file ts older than bridge start is ignored", async () => {
    await fs.mkdir(dir, { recursive: true });
    const commandsDir = commandsDirFor(eventsPath);
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.writeFile(
      path.join(commandsDir, `${process.pid}.json`),
      JSON.stringify({ model: "fixture/model-b", ts: Date.now() - 60_000 }),
    );
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
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sess-fixture", prompt: [] } })}\n`,
    );
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await readEvents());
    expect(liveInjects(lines)).toHaveLength(0);
  });

  test("commandsDir mkdir failure degrades gracefully and still forwards", async () => {
    await fs.mkdir(dir, { recursive: true });
    const commandsDir = commandsDirFor(eventsPath);
    // Pre-create a regular file where the commands directory should live, so
    // fs.mkdirSync(commandsDir, { recursive: true }) throws ENOTDIR.
    await fs.writeFile(commandsDir, "not a directory");
    const stdin = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c) => stdoutChunks.push(c as Buffer));
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin,
      stdout,
    });
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } })}\n`,
    );
    stdin.end();
    const { code } = await running;
    expect(code).toBe(0);
    const out = Buffer.concat(stdoutChunks).toString("utf8");
    expect(out).toContain("protocolVersion");
  });

  test("same ts rewrite of the live command file (no new write) is applied once", async () => {
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
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    const commandFile = path.join(commandsDirFor(eventsPath), `${process.pid}.json`);
    const ts = Date.now();
    await fs.writeFile(commandFile, JSON.stringify({ model: "fixture/model-b", ts }));
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sess-fixture", prompt: [] } })}\n`,
    );
    await Bun.sleep(200);
    // Rewritten with the identical ts/content: not a new command, so no retry.
    await fs.writeFile(commandFile, JSON.stringify({ model: "fixture/model-b", ts }));
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "sess-fixture", prompt: [] } })}\n`,
    );
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await readEvents());
    expect(liveInjects(lines)).toHaveLength(1);
  });

  test("live command file rewritten with a newer ts retries the same model", async () => {
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
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(200);
    writeModelCommand(eventsPath, process.pid, "fixture/model-b");
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sess-fixture", prompt: [] } })}\n`,
    );
    await Bun.sleep(200);
    await Bun.sleep(5);
    // Same model, but a fresh write (newer ts) is retry intent - e.g. the user
    // re-picked the same option after a failed apply - and must apply again.
    writeModelCommand(eventsPath, process.pid, "fixture/model-b");
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "sess-fixture", prompt: [] } })}\n`,
    );
    await Bun.sleep(200);
    stdin.end();
    await running;
    const lines = (await readEvents());
    expect(liveInjects(lines)).toHaveLength(2);
  });

  test("live switch works on session/resume without session/new", async () => {
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
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/resume", params: { sessionId: "sess-resume-1" } })}\n`,
    );
    await Bun.sleep(200);
    writeModelCommand(eventsPath, process.pid, "fixture/model-b");
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sess-resume-1", prompt: [] } })}\n`,
    );
    await Bun.sleep(300);
    stdin.end();
    await running;
    const lines = (await readEvents());
    const live = liveInjects(lines);
    expect(live).toHaveLength(1);
    expect(JSON.parse(live[0]!.raw).params.sessionId).toBe("sess-resume-1");
    expect(lines.some((e) => e.method === "session/new")).toBe(false);
  });

  test("session/resume injects model stored for that session id", async () => {
    await fs.mkdir(dir, { recursive: true });
    writeSessionModel(eventsPath, "sess-resume-1", "fixture/model-b");
    const stdin = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c) => stdoutChunks.push(c as Buffer));
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin,
      stdout,
    });
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/resume", params: { sessionId: "sess-resume-1" } })}\n`,
    );
    await Bun.sleep(300);
    stdin.end();
    await running;
    const lines = (await readEvents());
    const live = liveInjects(lines);
    expect(live).toHaveLength(1);
    expect(JSON.parse(live[0]!.raw).params.sessionId).toBe("sess-resume-1");
    expect(JSON.parse(live[0]!.raw).params.value).toBe("fixture/model-b");
    const out = Buffer.concat(stdoutChunks).toString("utf8");
    expect(out).not.toContain("bridge-live-");
  });

  test("cursor/create_plan is translated to message chunk and acked so prompt can finish", async () => {
    await fs.mkdir(dir, { recursive: true });
    const planFixture = path.join(import.meta.dir, "fixtures/acp-fake-cursor-plan.ts");
    const stdin = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c) => stdoutChunks.push(c as Buffer));
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [planFixture],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin,
      stdout,
      route: "cursor",
    });
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } })}\n`,
    );
    await Bun.sleep(100);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(150);
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "session/prompt",
        params: { sessionId: "sess-cursor-shim", prompt: [{ type: "text", text: "/plan" }] },
      })}\n`,
    );
    await Bun.sleep(400);
    stdin.end();
    await running;

    const out = Buffer.concat(stdoutChunks).toString("utf8");
    expect(out).not.toContain("cursor/create_plan");
    expect(out).toContain("Shim Plan");
    expect(out).toContain("Plan body");
    expect(out).toContain('"stopReason":"end_turn"');

    const lines = await readEvents();
    expect(lines.some((e) => e.method === "cursor/create_plan")).toBe(true);
    const ack = lines.find(
      (e) => e.dir === "c2a" && e.rpcId === 35 && e.raw.includes("accepted"),
    );
    expect(ack).toBeTruthy();
    const promptResult = lines.find(
      (e) => e.dir === "a2c" && e.rpcId === "prompt-1" && e.raw.includes("end_turn"),
    );
    expect(promptResult).toBeTruthy();
  });

  test("qoder extension request is acked and suppressed so prompt can finish", async () => {
    await fs.mkdir(dir, { recursive: true });
    const qoderFixture = path.join(import.meta.dir, "fixtures/acp-fake-qoder-blocking.ts");
    const stdin = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c) => stdoutChunks.push(c as Buffer));
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [qoderFixture],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin,
      stdout,
      route: "qodercli",
    });
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } })}\n`,
    );
    await Bun.sleep(100);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    await Bun.sleep(150);
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "prompt-qoder-1",
        method: "session/prompt",
        params: { sessionId: "sess-qoder-shim", prompt: [{ type: "text", text: "hello" }] },
      })}\n`,
    );
    await Bun.sleep(400);
    stdin.end();
    await running;

    const out = Buffer.concat(stdoutChunks).toString("utf8");
    expect(out).not.toContain("qoder/example");
    expect(out).toContain('"stopReason":"end_turn"');

    const lines = await readEvents();
    expect(lines.some((e) => e.method === "qoder/example")).toBe(true);
    expect(
      lines.some(
        (e) =>
          e.dir === "c2a" &&
          e.rpcId === 47 &&
          e.raw.includes('"outcome":{"outcome":"accepted"}'),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (e) => e.dir === "a2c" && e.rpcId === "prompt-qoder-1" && e.raw.includes("end_turn"),
      ),
    ).toBe(true);
  });
});
