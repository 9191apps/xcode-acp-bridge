/**
 * Minimal ACP agent that asks for permission before finishing a prompt turn.
 *
 * `export {}` keeps this file a module: the fixture shares helper names with the other fake agents
 * and relies on top-level await, both of which need module scope for `tsc --noEmit`.
 *
 * Used by tests/acp-yolo.test.ts:
 *   prompt "go"         → session/request_permission offering reject + allow options
 *   prompt "go noallow" → the same request but with reject options only (yolo must fail open)
 *
 * The agent finishes the turn only after it sees a response to its permission request, so a test
 * that observes `permission:<optionId>` on the backend proves the request was really answered.
 */
let permSeq = 0;
let pending: { permId: string; promptId: unknown; allowOptions: boolean } | null = null;

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function chunk(text: string): void {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-perm",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      },
    })}\n`,
  );
}

async function readLines(onLine: (line: string) => void): Promise<void> {
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
      if (line.trim()) onLine(line);
    }
  }
}

await readLines((line) => {
  let msg: {
    id?: unknown;
    method?: string;
    result?: { outcome?: { outcome?: unknown; optionId?: unknown } };
    params?: { prompt?: unknown };
  };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Response to our permission request: report the granted option, then end the turn.
  if (msg.method === undefined && pending && String(msg.id) === pending.permId) {
    const optionId = msg.result?.outcome?.optionId;
    chunk(`permission:${typeof optionId === "string" ? optionId : "none"}`);
    reply(pending.promptId, { stopReason: "end_turn" });
    pending = null;
    return;
  }

  if (msg.method === "initialize") {
    reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    return;
  }

  if (msg.method === "session/new") {
    reply(msg.id, { sessionId: "sess-perm" });
    return;
  }

  if (msg.method === "session/prompt") {
    const text = typeof msg.params?.prompt === "object" ? JSON.stringify(msg.params.prompt) : "";
    const allowOptions = !/noallow/.test(text);
    const permId = `perm-${++permSeq}`;
    pending = { permId, promptId: msg.id, allowOptions };
    const options = allowOptions
      ? [
          { optionId: "reject-once", kind: "reject_once", name: "Reject" },
          { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
          { optionId: "allow-always", kind: "allow_always", name: "Always allow" },
        ]
      : [
          { optionId: "reject-once", kind: "reject_once", name: "Reject" },
          { optionId: "reject-always", kind: "reject_always", name: "Always reject" },
        ];
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: permId,
        method: "session/request_permission",
        params: {
          sessionId: "sess-perm",
          toolCall: { toolCallId: "call-1", title: "Run tests", kind: "execute" },
          options,
        },
      })}\n`,
    );
  }
});

export {};
