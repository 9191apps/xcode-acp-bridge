#!/usr/bin/env bun
/**
 * Fixture: after session/prompt, emit cursor/create_plan (blocking) and wait for
 * the client ack before returning prompt stopReason. Used to verify bridge shim.
 */
async function readLines(onLine: (line: string) => void | Promise<void>): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  const reader = Bun.stdin.stream().getReader();
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

let planAcked = false;
let promptId: unknown = null;

await readLines(async (line) => {
  let msg: { id?: unknown; method?: string; result?: unknown; error?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Client ack for create_plan
  if (msg.id === 35 && msg.result !== undefined) {
    planAcked = true;
    if (promptId != null) {
      write({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      promptId = null;
    }
    return;
  }

  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === "session/new") {
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: { sessionId: "sess-cursor-shim" },
    });
    return;
  }
  if (msg.method === "session/prompt") {
    promptId = msg.id;
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-cursor-shim",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "thinking…" },
        },
      },
    });
    write({
      jsonrpc: "2.0",
      id: 35,
      method: "cursor/create_plan",
      params: {
        name: "Shim Plan",
        overview: "Overview text",
        plan: "# Plan body\n\nDo the thing.",
        todos: [{ id: "1", content: "Step one", status: "pending" }],
      },
    });
    // If already acked somehow, finish; otherwise wait for ack above.
    if (planAcked && promptId != null) {
      write({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      promptId = null;
    }
  }
});
