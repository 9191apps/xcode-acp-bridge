import { loadAcpBridgeConfig } from "./acp/config";
import { loadAcpRouteState, resolveRoute } from "./acp/route-state";
import { resolveBackendSpawnArgs } from "./acp/spawn-args";
import { runBridge } from "./acp/run-bridge";
import { MCP_PROXY_ARG, runMcpProxy } from "./acp/mcp-proxy";

// Proxy mode: `acp-bridge mcp-proxy <command> [args...]` pipes stdio to the
// real MCP server. Xcode's mcpbridge mcpServers entry is rewritten to this so
// Xcode's permission gate hashes this (re-signed) binary, not the backend's.
if (process.argv[2] === MCP_PROXY_ARG) {
  const code = await runMcpProxy(process.argv.slice(3));
  process.exit(code);
}

const cfg = loadAcpBridgeConfig();
const state = loadAcpRouteState(cfg.routeStatePath);
const resolved = resolveRoute(cfg, state);
if (resolved.fallbackReason) {
  console.error(`acp-bridge: using default route ${resolved.name} (${resolved.fallbackReason})`);
}

function onSignal() {
  process.stdin.destroy();
}
process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);

const pendingModel = resolved.fallbackReason === null ? (state?.model ?? null) : null;
const backendArgs = resolveBackendSpawnArgs(resolved.backend, pendingModel);

// YOLO is loud on purpose: it removes Xcode's approval step for this spawn.
const yolo = resolved.backend.yolo === true;
if (yolo) {
  console.error(
    `acp-bridge: YOLO enabled for route ${resolved.name} — session/request_permission is auto-approved by the bridge; Xcode will not prompt`,
  );
}

const { code } = await runBridge({
  backendCommand: resolved.backend.command,
  backendArgs,
  eventsPath: cfg.eventsPath,
  maxRawBytes: cfg.maxRawBytes,
  stdin: process.stdin,
  stdout: process.stdout,
  route: resolved.name,
  pendingModel,
  modelApply: resolved.backend.modelApply ?? "inject",
  yolo,
});
process.exit(code);
