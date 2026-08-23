#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadAcpBridgeConfig, repoRoot } from "../src/acp/config";
import {
  checkAgentAuth,
  checkQodercliAuth,
  detectAgent,
  detectBackendBinary,
  detectOpencode,
  detectQodercli,
  hasExecutable,
  hasFile,
  registrationInfo,
} from "../src/setup-check";

const args = new Set(process.argv.slice(2));
const skipInstall = args.has("--skip-install");
const writeConfig = args.has("--write");

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function ok(msg: string): void {
  console.log(`  ${C.green}✔${C.reset} ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ${C.yellow}⚠${C.reset} ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ${C.red}✖${C.reset} ${msg}`);
}

function section(title: string): void {
  console.log(`\n${C.bold}${title}${C.reset}`);
}

/** Prefer portable ~ paths for known install locations when rewriting config. */
function portableCommand(routeName: string, detected: string): string {
  const base = path.basename(detected);
  if (
    (routeName === "cursor" || base === "agent" || base === "cursor-agent") &&
    detected.includes(`${path.sep}.local${path.sep}bin${path.sep}agent`)
  ) {
    return "~/.local/bin/agent";
  }
  if (base === "opencode" && detected.includes(`${path.sep}.opencode${path.sep}`)) {
    return "~/.opencode/bin/opencode";
  }
  if (
    (routeName === "qodercli" || base === "qodercli" || base === "qoder") &&
    detected.includes(`${path.sep}.local${path.sep}bin${path.sep}qodercli`)
  ) {
    return "~/.local/bin/qodercli";
  }
  return detected;
}

const root = repoRoot();
const dashboardUrl = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

console.log(`${C.bold}Xcode ACP Bridge — setup${C.reset}`);
console.log(`${C.dim}repo: ${root}${C.reset}`);

section("1. Runtime");
ok(`bun ${process.versions.bun ?? Bun.version}`);
const bunBin = registrationInfo().interpreter;
if (!hasExecutable(bunBin)) {
  fail(`bun binary not found at ${bunBin}`);
  process.exit(1);
}

section("2. Dependencies");
if (skipInstall) {
  warn("skipping bun install (--skip-install)");
} else {
  const res = spawnSync("bun", ["install"], { stdio: "inherit", cwd: root });
  if (res.status !== 0) {
    fail("bun install failed");
    process.exit(1);
  }
  ok("bun install");
}

section("3. ACP config");
let cfg;
try {
  cfg = loadAcpBridgeConfig();
  ok(`acp-bridge.config.json loaded (default route: ${cfg.defaultRoute})`);
} catch (err) {
  fail(`could not load acp-bridge.config.json: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

for (const [name, backend] of Object.entries(cfg.routes)) {
  const marker = name === cfg.defaultRoute ? ` (default)` : "";
  const exists = hasExecutable(backend.command);
  const label = `route ${C.cyan}${name}${C.reset}${marker}: ${backend.command} ${backend.args.join(" ")}`;
  if (exists) ok(label);
  else fail(label + "  → not executable");
}

const missing = Object.entries(cfg.routes).filter(([, b]) => !hasExecutable(b.command));
if (missing.length > 0) {
  if (writeConfig) {
    const configPath = process.env.ACP_BRIDGE_CONFIG ?? path.join(root, "acp-bridge.config.json");
    const text = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(text) as {
      routes?: Record<
        string,
        { command?: string; args?: string[]; modelsCommand?: { command?: string; args?: string[] } }
      >;
    };
    let wroteAny = false;
    if (parsed.routes) {
      for (const [name, backend] of Object.entries(parsed.routes)) {
        const detected = detectBackendBinary(name, backend.command ?? "");
        if (!detected) {
          warn(`route ${name}: no matching binary found`);
          continue;
        }
        if (backend.command && !hasExecutable(backend.command)) {
          backend.command = portableCommand(name, detected);
          wroteAny = true;
          ok(`route ${name}: command → ${backend.command}`);
        }
        if (backend.modelsCommand?.command && !hasExecutable(backend.modelsCommand.command)) {
          backend.modelsCommand.command = backend.command ?? portableCommand(name, detected);
          wroteAny = true;
        }
      }
      if (wroteAny) {
        fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
        ok(`rewrote ${configPath}`);
        cfg = loadAcpBridgeConfig();
      }
    }
  } else {
    for (const [name, backend] of missing) {
      const detected = detectBackendBinary(name, backend.command);
      if (detected) warn(`route ${name}: found ${detected} — re-run with --write to update config`);
      else warn(`route ${name}: no matching binary found`);
    }
  }

  const stillMissing = Object.entries(cfg.routes).filter(([, b]) => !hasExecutable(b.command));
  if (stillMissing.length > 0 && !detectOpencode() && !detectAgent() && !detectQodercli()) {
    fail("no route command is executable on this machine");
    warn("install opencode, Cursor CLI (`agent`), and/or Qoder CLI (`qodercli`), or edit acp-bridge.config.json");
  }
} else {
  ok("all route commands executable");
}

const agentRoutes = Object.entries(cfg.routes).filter(
  ([name, b]) => name === "cursor" || path.basename(b.command) === "agent",
);
if (agentRoutes.length > 0) {
  const agentBin =
    agentRoutes.find(([, b]) => hasExecutable(b.command))?.[1].command ?? detectAgent();
  if (agentBin && hasExecutable(agentBin)) {
    const auth = checkAgentAuth(agentBin);
    if (auth.authenticated) ok(`cursor agent auth: ${auth.detail}`);
    else warn(`cursor agent auth: ${auth.detail}`);
  } else {
    warn("cursor route present but agent binary not found — install Cursor CLI");
  }
}

const qoderRoutes = Object.entries(cfg.routes).filter(
  ([name, b]) => name === "qodercli" || ["qodercli", "qoder"].includes(path.basename(b.command)),
);
if (qoderRoutes.length > 0) {
  const qoderBin =
    qoderRoutes.find(([, b]) => hasExecutable(b.command))?.[1].command ?? detectQodercli();
  if (qoderBin && hasExecutable(qoderBin)) {
    const auth = checkQodercliAuth(qoderBin);
    if (auth.authenticated) ok(`qodercli auth: ${auth.detail}`);
    else warn(`qodercli auth: ${auth.detail}`);
  } else {
    warn("qodercli route present but qodercli binary not found — install Qoder CLI");
  }
}

section("4. Xcode ACP Agent registration");
const reg = registrationInfo();
if (!hasFile(reg.executable)) {
  fail(`src/acp-bridge.ts missing at ${reg.executable}`);
  process.exit(1);
}
ok(`bridge script: ${reg.executable}`);
ok(`bun interpreter: ${reg.interpreter}`);
console.log(`${C.bold}Settings → Intelligence → Add an ACP Agent:${C.reset}`);
console.log(`  ${C.cyan}Name${C.reset}        ${reg.name}`);
console.log(`  ${C.cyan}Executable${C.reset}  ${reg.executable}`);
console.log(`  ${C.cyan}Interpreter${C.reset} ${reg.interpreter}`);
console.log(`  ${C.cyan}Arguments${C.reset}   (empty)`);

section("5. Verify");
const res = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${dashboardUrl}/health`], {
  encoding: "utf8",
});
if (res.status === 0 && res.stdout.trim() === "200") {
  ok(`dashboard already running at ${dashboardUrl}`);
} else {
  warn(`dashboard not running yet — start it with: ${C.cyan}bun run start${C.reset}`);
}

console.log(`\n${C.bold}Done.${C.reset} Next: register the ACP Agent above in Xcode, then run ${C.cyan}bun run start${C.reset}.`);
