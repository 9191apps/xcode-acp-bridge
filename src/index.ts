import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { loadAcpBridgeConfig } from "./acp/config";
import { AcpEventStore } from "./acp/event-store";
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
app.get("/health", (c) => c.json({ ok: true }));
app.use("/*", serveStatic({ root: "./public" }));

try {
  Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
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
