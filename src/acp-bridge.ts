import { loadAcpBridgeConfig } from "./acp/config";
import { loadAcpRouteState, resolveRoute } from "./acp/route-state";
import { resolveBackendSpawnArgs } from "./acp/spawn-args";
import { runBridge } from "./acp/run-bridge";

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
});
process.exit(code);
