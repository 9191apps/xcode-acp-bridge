// Minimal MCP stdio server (newline-delimited JSON-RPC 2.0) used to prove that
// `acp-bridge mcp-proxy <command>` forwards a real MCP session byte-for-byte.
// No Xcode dependency: handshake, tools/list and tools/call are enough to show
// both directions survive the proxy framing.
const TOOLS = [
  {
    name: "echo",
    description: "Echo back the `text` argument",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
];

function write(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handle(msg: Record<string, unknown>): void {
  const id = msg.id;
  switch (msg.method) {
    case "initialize":
      write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture-mcp", version: "0.0.0" },
        },
      });
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    case "tools/call": {
      const args = (msg.params as { arguments?: { text?: unknown } } | undefined)?.arguments;
      write({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: String(args?.text ?? "") }] },
      });
      return;
    }
    default:
      if (id != null) {
        write({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
      }
  }
}

const decoder = new TextDecoder();
let buf = "";
const reader = Bun.stdin.stream().getReader();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(JSON.parse(line));
  }
}
