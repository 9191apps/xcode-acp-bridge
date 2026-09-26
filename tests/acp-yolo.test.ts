import { describe, expect, test, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runBridge } from "../src/acp/run-bridge";

const dir = path.join(import.meta.dir, ".tmp-acp-yolo");
const eventsPath = path.join(dir, "acp-events.jsonl");
const fixture = path.join(import.meta.dir, "fixtures/acp-permission-agent.ts");

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

/** Xcode's side of the stdio bridge: line-buffered stdout plus a `wait` for expected lines. */
function xcodeSide() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: string[] = [];
  const waiters: Array<{ match: (line: string) => boolean; resolve: (line: string) => void }> = [];
  let buf = "";
  stdout.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      lines.push(line);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.match(line)) {
          const waiter = waiters[i]!;
          waiters.splice(i, 1);
          waiter.resolve(line);
        }
      }
    }
  });
  const wait = (match: (line: string) => boolean, timeoutMs = 5000): Promise<string | null> =>
    Promise.race([
      new Promise<string>((resolve) => waiters.push({ match, resolve })),
      Bun.sleep(timeoutMs).then(() => null),
    ]);
  return { stdin, stdout, lines, wait };
}

function promptLine(id: number, text: string): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId: "sess-perm", prompt: [{ type: "text", text }] },
  })}\n`;
}

describe("yolo permission auto-approval", () => {
  test("with yolo on the bridge answers session/request_permission and Xcode never sees it", async () => {
    await fs.mkdir(dir, { recursive: true });
    const xc = xcodeSide();
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin: xc.stdin,
      stdout: xc.stdout,
      yolo: true,
    });

    const turnDone = xc.wait((line) => line.includes("end_turn"));
    xc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } })}\n`,
    );
    xc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    xc.stdin.write(promptLine(2, "go"));

    expect(await turnDone).not.toBeNull();
    xc.stdin.end();
    await running;

    const out = xc.lines.join("\n");
    expect(out).toContain("permission:allow-always"); // agent ran on the grant the bridge picked
    expect(out).not.toContain("session/request_permission"); // no approval prompt for Xcode

    // Observability: both sides of the decision are in the JSONL.
    const events = await readEvents();
    const request = events.find(
      (e) => e.dir === "a2c" && e.method === "session/request_permission",
    );
    expect(request).toBeTruthy();
    const reply = events.find(
      (e) => e.dir === "c2a" && String(e.raw).includes("allow-always"),
    );
    expect(reply).toBeTruthy();
    expect(String(reply!.raw)).toContain('"outcome":"selected"');
  });

  test("without yolo the request is forwarded and Xcode's answer is relayed back", async () => {
    await fs.mkdir(dir, { recursive: true });
    const xc = xcodeSide();
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin: xc.stdin,
      stdout: xc.stdout,
    });

    const asked = xc.wait((line) => line.includes("session/request_permission"));
    xc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } })}\n`,
    );
    xc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    xc.stdin.write(promptLine(2, "go"));

    const askedLine = await asked;
    expect(askedLine).not.toBeNull();
    const permId = (JSON.parse(askedLine!) as { id: unknown }).id;

    const turnDone = xc.wait((line) => line.includes("end_turn"));
    xc.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: permId,
        result: { outcome: { outcome: "selected", optionId: "allow-once" } },
      })}\n`,
    );
    expect(await turnDone).not.toBeNull();
    xc.stdin.end();
    await running;

    expect(xc.lines.join("\n")).toContain("permission:allow-once");
  });

  test("with yolo on a reject-only request still goes to Xcode (fail open)", async () => {
    await fs.mkdir(dir, { recursive: true });
    const xc = xcodeSide();
    const running = runBridge({
      backendCommand: process.execPath,
      backendArgs: [fixture],
      eventsPath,
      maxRawBytes: 2 * 1024 * 1024,
      stdin: xc.stdin,
      stdout: xc.stdout,
      yolo: true,
    });

    const asked = xc.wait((line) => line.includes("session/request_permission"));
    xc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } })}\n`,
    );
    xc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
    xc.stdin.write(promptLine(2, "go noallow"));

    const askedLine = await asked;
    expect(askedLine).not.toBeNull();
    const permId = (JSON.parse(askedLine!) as { id: unknown }).id;

    const turnDone = xc.wait((line) => line.includes("end_turn"));
    xc.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: permId,
        result: { outcome: { outcome: "selected", optionId: "reject-once" } },
      })}\n`,
    );
    expect(await turnDone).not.toBeNull();
    xc.stdin.end();
    await running;

    expect(xc.lines.join("\n")).toContain("permission:reject-once");
  });
});
