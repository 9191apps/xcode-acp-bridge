#!/usr/bin/env bun
/**
 * Interactive Terminal resume for Qoder ACP sessions.
 *
 * ACP sessions must be resumed via JSON-RPC session/load.
 *
 * Usage:
 *   bun src/acp/qoder-acp-resume.ts --agent ~/.local/bin/qodercli --session-id <uuid> [--cwd <path>]
 */
import { spawn } from "bun";
import readline from "node:readline";

function usage(): never {
  console.error(
    "usage: qoder-acp-resume.ts --agent <path> --session-id <id> [--cwd <path>]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): { agent: string; sessionId: string; cwd: string } {
  let agent: string | null = null;
  let sessionId: string | null = null;
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--agent") agent = argv[++i] ?? null;
    else if (a === "--session-id") sessionId = argv[++i] ?? null;
    else if (a === "--cwd") cwd = argv[++i] ?? cwd;
    else if (a === "-h" || a === "--help") usage();
  }
  if (!agent || !sessionId) usage();
  return { agent, sessionId, cwd };
}

const { agent, sessionId, cwd } = parseArgs(process.argv.slice(2));

const proc = spawn([agent, "--acp"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
  cwd,
});

const decoder = new TextDecoder();
let buf = "";
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function send(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function respond(id: unknown, result: unknown): void {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function onLine(line: string): void {
  if (!line.trim()) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
    const waiter = pending.get(msg.id as number);
    if (!waiter) return;
    pending.delete(msg.id as number);
    if (msg.error) {
      waiter.reject(new Error(JSON.stringify(msg.error)));
    } else {
      waiter.resolve(msg.result);
    }
    return;
  }

  if (msg.method === "session/update") {
    const update = (msg.params as { update?: Record<string, unknown> } | undefined)?.update;
    if (!update) return;
    const kind = update.sessionUpdate;
    if (
      (kind === "agent_message_chunk" || kind === "agent_thought_chunk") &&
      update.content &&
      typeof update.content === "object" &&
      typeof (update.content as { text?: unknown }).text === "string"
    ) {
      const text = (update.content as { text: string }).text;
      if (kind === "agent_thought_chunk") {
        process.stderr.write(text);
      } else {
        process.stdout.write(text);
      }
    }
    return;
  }

  if (msg.method === "session/request_permission") {
    respond(msg.id, { outcome: { outcome: "selected", optionId: "allow-once" } });
  }
}

const pump = (async () => {
  const reader = proc.stdout.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      onLine(line);
    }
  }
})();

function ask(prompt: string): Promise<string | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => resolve(null));
  });
}

try {
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "xcode-acp-bridge-resume", version: "0.1.0" },
  });
  await send("authenticate", { methodId: "qodercli-login" });
  console.error(`[resume] loading ACP session ${sessionId} in ${cwd}…`);
  await send("session/load", { sessionId, cwd, mcpServers: [] });
  console.error("\n[resume] session loaded. Type a message (empty line or Ctrl-D to quit).\n");

  while (true) {
    const line = await ask("> ");
    if (line == null) break;
    const text = line.trim();
    if (text.length === 0) break;
    process.stdout.write("\n");
    const result = (await send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    })) as { stopReason?: string };
    process.stdout.write("\n");
    if (result?.stopReason) {
      console.error(`[stopReason=${result.stopReason}]`);
    }
    process.stdout.write("\n");
  }
} catch (err) {
  console.error(`[resume] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  try {
    proc.stdin.end();
  } catch {
    // ignore
  }
  proc.kill();
  await Promise.race([pump, Bun.sleep(300)]);
}
