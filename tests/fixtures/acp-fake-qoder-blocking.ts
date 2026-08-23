#!/usr/bin/env bun
/**
 * Fixture: emit a blocking qoder extension request after session/prompt and
 * only finish once the bridge acknowledges that request.
 */
async function readLines(onLine: (line: string) => void | Promise<void>): Promise<void> {
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) await onLine(line);
    }
  }
}

function write(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let extensionAcked = false;
let promptId: unknown = null;

function finishPrompt(): void {
  if (promptId == null || !extensionAcked) return;
  write({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  promptId = null;
}

await readLines(async (line) => {
  let msg: { id?: unknown; method?: string; result?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.id === 47 && msg.result !== undefined) {
    extensionAcked = true;
    finishPrompt();
    return;
  }

  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === "session/new") {
    write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-qoder-shim" } });
    return;
  }
  if (msg.method === "session/prompt") {
    promptId = msg.id;
    write({
      jsonrpc: "2.0",
      id: 47,
      method: "qoder/example",
      params: {},
    });
    finishPrompt();
  }
});
