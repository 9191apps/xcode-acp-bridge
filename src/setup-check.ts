import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAcpBridgeConfig, repoRoot } from "./acp/config";

export function hasFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function pathExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function hasExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function which(cmd: string): string | null {
  const res = spawnSync("which", [cmd], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const out = res.stdout.trim();
  return out.length > 0 ? out : null;
}

export function detectOpencode(): string | null {
  const candidates = [
    ...(which("opencode") ? [which("opencode")!] : []),
    path.join(os.homedir(), ".opencode", "bin", "opencode"),
    path.join(os.homedir(), ".local", "bin", "opencode"),
  ].filter((p, i, a) => p && a.indexOf(p) === i && hasExecutable(p));
  return candidates.length > 0 ? candidates[0] : null;
}

export function detectAgent(): string | null {
  const candidates = [
    ...(which("agent") ? [which("agent")!] : []),
    path.join(os.homedir(), ".local", "bin", "agent"),
  ].filter((p, i, a) => p && a.indexOf(p) === i && hasExecutable(p));
  return candidates.length > 0 ? candidates[0] : null;
}

export function detectQodercli(): string | null {
  const candidates = [
    ...(which("qodercli") ? [which("qodercli")!] : []),
    path.join(os.homedir(), ".local", "bin", "qodercli"),
  ].filter((p, i, a) => p && a.indexOf(p) === i && hasExecutable(p));
  return candidates.length > 0 ? candidates[0] : null;
}

/** Prefer Cursor agent / Qoder CLI / OpenCode by route and command basename. */
export function detectBackendBinary(routeName: string, command: string): string | null {
  const base = path.basename(command);
  if (routeName === "cursor" || base === "agent" || base === "cursor-agent") {
    return detectAgent();
  }
  if (routeName === "qodercli" || base === "qodercli" || base === "qoder") {
    return detectQodercli();
  }
  return detectOpencode();
}

export type AgentAuthStatus = { ok: boolean; authenticated: boolean; detail: string };

export type QodercliAuthStatus = AgentAuthStatus;

export function checkQodercliAuth(qoderBin: string): QodercliAuthStatus {
  const res = spawnSync(qoderBin, ["status"], { encoding: "utf8", timeout: 8000 });
  if (res.error) {
    return { ok: false, authenticated: false, detail: res.error.message };
  }
  const stdout = (res.stdout || "").trim();
  if (res.status !== 0 || !stdout) {
    return {
      ok: false,
      authenticated: false,
      detail: "not authenticated — run `qodercli login` or set QODER_PERSONAL_ACCESS_TOKEN",
    };
  }
  if (stdout.includes("Username:")) {
    return { ok: true, authenticated: true, detail: "authenticated" };
  }
  return {
    ok: true,
    authenticated: false,
    detail: "not authenticated — run `qodercli login` or set QODER_PERSONAL_ACCESS_TOKEN",
  };
}

export function checkAgentAuth(agentBin: string): AgentAuthStatus {
  const res = spawnSync(agentBin, ["status", "--format", "json"], { encoding: "utf8", timeout: 8000 });
  if (res.error) {
    return { ok: false, authenticated: false, detail: res.error.message };
  }
  if (res.status !== 0) {
    return {
      ok: false,
      authenticated: false,
      detail: (res.stderr || res.stdout || `exit ${res.status}`).trim().slice(0, 200),
    };
  }
  try {
    const parsed = JSON.parse(res.stdout.trim()) as { isAuthenticated?: boolean; status?: string };
    const authenticated = parsed.isAuthenticated === true || parsed.status === "authenticated";
    return {
      ok: true,
      authenticated,
      detail: authenticated ? "authenticated" : "not authenticated — run `agent login` or set CURSOR_API_KEY",
    };
  } catch {
    return { ok: false, authenticated: false, detail: "could not parse agent status JSON" };
  }
}

export type RegistrationInfo = {
  name: string;
  executable: string;
  interpreter: string;
  arguments: string[];
};

export function registrationInfo(): RegistrationInfo {
  return {
    name: "ACP Bridge",
    executable: path.join(repoRoot(), "src", "acp-bridge.ts"),
    interpreter: process.execPath,
    arguments: [],
  };
}

export type CheckResult = { ok: boolean; label: string };

export function checkSetup(): CheckResult[] {
  const results: CheckResult[] = [];

  results.push({
    ok: hasExecutable(process.execPath),
    label: `bun ${process.versions.bun ?? Bun.version} at ${process.execPath}`,
  });

  const depsOk = pathExists(path.join(repoRoot(), "node_modules", "hono"));
  results.push({ ok: depsOk, label: "dependencies installed (run bun install)" });

  let cfg;
  try {
    cfg = loadAcpBridgeConfig();
    results.push({ ok: true, label: "acp-bridge.config.json loaded" });
  } catch (err) {
    results.push({ ok: false, label: `acp-bridge.config.json: ${err instanceof Error ? err.message : err}` });
  }

  if (cfg) {
    for (const [name, backend] of Object.entries(cfg.routes)) {
      results.push({
        ok: hasExecutable(backend.command),
        label: `route ${name}: ${backend.command} executable`,
      });
    }
  }

  results.push({ ok: hasFile(registrationInfo().executable), label: "src/acp-bridge.ts present" });

  return results;
}
