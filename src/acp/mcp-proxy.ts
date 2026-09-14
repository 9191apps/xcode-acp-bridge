import path from "node:path";

// Xcode's session/new hands the agent its MCP server as a stdio entry like:
//   { command: "xcrun", args: ["mcpbridge"], env: [MCP_XCODE_PID, MCP_XCODE_SESSION_ID] }
// The agent (backend) spawns it directly, so when the MCP XPC connection
// reaches Xcode, Xcode's HeadlessPermissionGate SHA-256-hashes the *backend*
// binary (e.g. opencode) to match permission grants. bun-compiled backends
// ship a linker ad-hoc signature whose page hashes do not match the file
// bytes; Xcode's mmap'd hash then trips a CODESIGNING "Invalid Page" SIGKILL
// that kills Xcode itself (see docs: crash 2026-09-14).
//
// Interposing this bridge (a properly re-signed sidecar) between the backend
// and mcpbridge makes Xcode hash the bridge binary instead: the mcpbridge
// mcpServers entry is rewritten to spawn `acp-bridge mcp-proxy <command> …`,
// which is a dumb byte-level stdio pipe to the real command.

export const MCP_PROXY_ARG = "mcp-proxy";

/**
 * argv prefix that re-enters this binary in proxy mode.
 * Packaged sidecar: ["/…/acp-bridge"]. Dev checkout: ["/…/bun", "/…/src/acp-bridge.ts"].
 */
export function xcodeMcpProxyPrefix(
  execPath: string = process.execPath,
  entryPath: string | undefined = process.argv[1],
): string[] {
  const execBase = path.basename(execPath).toLowerCase();
  if (execBase.startsWith("bun") && entryPath) return [execPath, entryPath];
  return [execPath];
}

type McpServerEntry = {
  command?: unknown;
  args?: unknown;
  [key: string]: unknown;
};

function isXcodeMcpBridgeEntry(entry: McpServerEntry): boolean {
  if (typeof entry.command !== "string") return false;
  const base = path.basename(entry.command);
  if (base === "mcpbridge") return true;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return base === "xcrun" && args.includes("mcpbridge");
}

/**
 * Rewrite stdio mcpServers entries that spawn Xcode's mcpbridge so they go
 * through `acp-bridge mcp-proxy` instead (env and other fields preserved;
 * non-Xcode servers untouched). Returns the original line when nothing
 * matches or the payload is not a session init request.
 */
export function rewriteXcodeMcpServers(line: string, prefix: string[]): string {
  let msg: { method?: unknown; params?: { mcpServers?: unknown } };
  try {
    msg = JSON.parse(line);
  } catch {
    return line;
  }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return line;
  if (
    msg.method !== "session/new" &&
    msg.method !== "session/load" &&
    msg.method !== "session/resume"
  ) {
    return line;
  }
  const servers = msg.params?.mcpServers;
  if (!Array.isArray(servers) || servers.length === 0) return line;
  let changed = false;
  const rewritten = servers.map((entry: McpServerEntry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    if (!isXcodeMcpBridgeEntry(entry)) return entry;
    changed = true;
    return {
      ...entry,
      command: prefix[0],
      args: [
        ...prefix.slice(1),
        MCP_PROXY_ARG,
        entry.command as string,
        ...((Array.isArray(entry.args) ? entry.args : []) as unknown[]),
      ],
    };
  });
  if (!changed) return line;
  return JSON.stringify({ ...msg, params: { ...msg.params, mcpServers: rewritten } });
}

/** Byte-level stdio pipe to the real MCP server command. */
export async function runMcpProxy(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    console.error("acp-bridge mcp-proxy: missing command");
    return 2;
  }
  const proc = Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  const onSignal = () => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
    process.exit(0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // Backend stdout → our stdout (raw bytes; MCP framing passes through).
  const outDone = (async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length > 0) process.stdout.write(value);
      }
    } catch {
      // stdout already closed
    }
  })();

  // Our stdin → backend stdin (raw bytes).
  const inDone = new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        proc.stdin.end();
      } catch {
        // already closed
      }
      resolve();
    };
    process.stdin.on("data", (chunk: Buffer | string) => {
      try {
        proc.stdin.write(chunk);
      } catch {
        // backend stdin already closed
      }
    });
    process.stdin.on("end", done);
    process.stdin.on("close", done);
    process.stdin.on("error", done);
    process.stdin.resume();
  });

  const code = await proc.exited;
  process.stdin.destroy();
  await inDone;
  await outDone;
  return code ?? 0;
}
