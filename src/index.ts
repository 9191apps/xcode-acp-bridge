import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { loadAcpBridgeConfig } from "./acp/config";
import { AcpEventStore } from "./acp/event-store";
import { publicDir } from "./acp/paths";
import { startAcpTail } from "./acp/tail";
import { config } from "./config";
import { createAcpDashboardApp } from "./dashboard/acp-routes";
import { EventHub } from "./dashboard/events";
import { checkSetup, registrationInfo } from "./setup-check";

const acpCfg = loadAcpBridgeConfig();
const acpStore = new AcpEventStore(acpCfg.eventsPath);
await acpStore.load();
const acpHub = new EventHub();
startAcpTail(acpStore, (e) => acpHub.publishNamed("acp", e));

const app = new Hono();
app.route("/", createAcpDashboardApp(acpStore, acpHub, { config: acpCfg }));
app.use("/*", serveStatic({ root: publicDir() }));

try {
  Bun.serve({
    hostname: config.host,
    port: config.port,
    // Default Bun idleTimeout is 10s. Quiet SSE streams count as idle, so the
    // Observatory EventSource was reset every ~10s → RECONNECT flicker. Keep a
    // modest global timeout for normal requests; disable it per-request for SSE.
    idleTimeout: 30,
    fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === "/acp-events") {
        server.timeout(req, 0);
      }
      return app.fetch(req);
    },
  });
  console.log(`Xcode ACP Bridge listening on http://${config.host}:${config.port}`);
} catch (err) {
  console.error(`Failed to bind ${config.host}:${config.port}. Is the port in use?`);
  console.error(err);
  process.exit(1);
}

const failures = checkSetup().filter((c) => !c.ok);
if (failures.length > 0) {
  console.warn("\nSetup incomplete:");
  for (const f of failures) console.warn(`  ✖ ${f.label}`);
  console.warn(`  Run \`bun run setup\` to fix.`);
}

const reg = registrationInfo();
console.log("\nACP Agent (Settings → Intelligence → Add an ACP Agent):");
console.log(`  Name        ${reg.name}`);
console.log(`  Executable  ${reg.executable}`);
console.log(`  Interpreter ${reg.interpreter}`);
console.log(`  Arguments   (empty)`);
