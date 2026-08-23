let currentModel = "fixture/model-a";
let currentMode = "build";

function configOptions() {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: [
        { value: "fixture/model-a", name: "Model A" },
        { value: "fixture/model-b", name: "Model B" },
      ],
    },
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: currentMode,
      options: [
        { value: "build", name: "build" },
        { value: "plan", name: "plan" },
      ],
    },
  ];
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

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id: unknown, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message } })}\n`,
  );
}

await readLines((line) => {
  let msg: {
    id?: unknown;
    method?: string;
    params?: { configId?: unknown; value?: unknown; sessionId?: unknown; modeId?: unknown };
  };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    return;
  }
  if (msg.method === "session/new") {
    reply(msg.id, { sessionId: "sess-fixture", configOptions: configOptions() });
    return;
  }
  if (msg.method === "session/resume" || msg.method === "session/load") {
    const sessionId =
      typeof msg.params?.sessionId === "string" && msg.params.sessionId.length > 0
        ? msg.params.sessionId
        : "sess-fixture";
    reply(msg.id, { sessionId, configOptions: configOptions() });
    return;
  }
  if (msg.method === "session/set_config_option") {
    const value = msg.params?.value;
    if (
      msg.params?.configId === "model" &&
      (value === "fixture/model-a" || value === "fixture/model-b")
    ) {
      currentModel = value;
      reply(msg.id, { configOptions: configOptions() });
    } else {
      replyError(msg.id, "unknown config option or value");
    }
    return;
  }
  if (msg.method === "session/set_mode") {
    const modeId = msg.params?.modeId;
    if (modeId === "build" || modeId === "plan") {
      currentMode = modeId;
      reply(msg.id, {});
    } else {
      replyError(msg.id, `Invalid params: mode not found: ${modeId}`);
    }
    return;
  }
  if (msg.method === "session/prompt") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-fixture",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        },
      })}\n`,
    );
    reply(msg.id, { stopReason: "end_turn" });
  }
});
