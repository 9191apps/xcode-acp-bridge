import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAcpPathLayout } from "./paths";
import type { AcpBackend, AcpBridgeConfig, AcpCommand } from "./types";

function expandPath(value: string): string {
  let out = value;
  if (out === "~" || out.startsWith("~/")) {
    out = os.homedir() + out.slice(1);
  }
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g, (_match, name: string) => process.env[name] ?? "");
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => process.env[name] ?? "");
  return out;
}

function expandCommand(cmd: AcpCommand): AcpCommand {
  return { command: expandPath(cmd.command), args: cmd.args.map(expandPath) };
}

function expandBackend(backend: AcpBackend, yoloDefault = false): AcpBackend {
  const expanded = expandCommand(backend);
  const withModels = backend.modelsCommand
    ? { ...expanded, modelsCommand: expandCommand(backend.modelsCommand) }
    : expanded;
  // Only the enabled state is kept: `yolo: false` and an absent field are the same thing, and the
  // route-level value (when present) wins over the top-level default.
  const yolo = backend.yolo ?? yoloDefault;
  return {
    ...withModels,
    ...(backend.modelApply !== undefined ? { modelApply: backend.modelApply } : {}),
    ...(backend.resumeArgs !== undefined ? { resumeArgs: backend.resumeArgs.map(expandPath) } : {}),
    ...(backend.resumeMode !== undefined ? { resumeMode: backend.resumeMode } : {}),
    ...(yolo ? { yolo: true } : {}),
  };
}

/** Git checkout root; for runtime data use {@link resolveAcpPathLayout}. */
export function repoRoot(): string {
  return path.resolve(import.meta.dir, "../..");
}

export function defaultConfigPath(): string {
  return resolveAcpPathLayout().configPath;
}

function resolveConfigPath(configPath: string): string {
  const layout = resolveAcpPathLayout();
  return path.isAbsolute(configPath) ? configPath : path.join(layout.home, configPath);
}

function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

function isCommand(value: unknown): value is AcpCommand {
  if (typeof value !== "object" || value === null) return false;
  const cmd = value as Record<string, unknown>;
  return typeof cmd.command === "string" && Array.isArray(cmd.args);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isBackend(value: unknown): value is AcpBackend {
  if (!isCommand(value)) return false;
  const backend = value as Record<string, unknown>;
  const modelsCommand = backend.modelsCommand;
  if (modelsCommand !== undefined && !isCommand(modelsCommand)) return false;
  const modelApply = backend.modelApply;
  if (modelApply !== undefined && modelApply !== "inject" && modelApply !== "spawn-arg") return false;
  const resumeArgs = backend.resumeArgs;
  if (resumeArgs !== undefined && !isStringArray(resumeArgs)) return false;
  const resumeMode = backend.resumeMode;
  if (
    resumeMode !== undefined &&
    resumeMode !== "args" &&
    resumeMode !== "cursor-acp-load" &&
    resumeMode !== "qoder-acp-load"
  )
    return false;
  const yolo = backend.yolo;
  if (yolo !== undefined && typeof yolo !== "boolean") return false;
  return true;
}

export function loadAcpBridgeConfig(configPath: string = defaultConfigPath()): AcpBridgeConfig {
  const text = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(text) as Record<string, unknown>;

  const yoloDefault = parsed.yolo;
  if (yoloDefault !== undefined && typeof yoloDefault !== "boolean") {
    throw new Error("acp-bridge config: yolo must be a boolean");
  }

  let routes: Record<string, AcpBackend>;
  let defaultRoute: string;

  if (isNonEmptyObject(parsed.routes)) {
    routes = {};
    for (const [key, value] of Object.entries(parsed.routes)) {
      if (!isBackend(value)) {
        throw new Error(`acp-bridge config: routes.${key} is not a valid backend`);
      }
      routes[key] = expandBackend(value, yoloDefault === true);
    }
    defaultRoute = parsed.defaultRoute as string;
  } else if (isBackend(parsed.defaultBackend)) {
    routes = { default: expandBackend(parsed.defaultBackend, yoloDefault === true) };
    defaultRoute = typeof parsed.defaultRoute === "string" ? parsed.defaultRoute : "default";
  } else {
    throw new Error("acp-bridge config: routes is empty");
  }

  if (typeof defaultRoute !== "string" || !(defaultRoute in routes)) {
    throw new Error(`acp-bridge config: defaultRoute ${defaultRoute ?? "undefined"} not in routes`);
  }

  const eventsPath = resolveConfigPath(parsed.eventsPath as string);
  const routeStatePath = resolveConfigPath(
    typeof parsed.routeStatePath === "string" ? parsed.routeStatePath : "./data/acp-route.json",
  );
  const maxRawBytes = parsed.maxRawBytes;
  if (typeof maxRawBytes !== "number" || !Number.isFinite(maxRawBytes) || maxRawBytes <= 0) {
    throw new Error("acp-bridge config: maxRawBytes must be a positive number");
  }
  const defaultBackend = routes[defaultRoute];

  return { routes, defaultRoute, defaultBackend, eventsPath, routeStatePath, maxRawBytes };
}

/**
 * Set `routes[<route>].yolo` in the config file — the dashboard's per-route permission switch.
 *
 * The file on disk stays the source of truth: the Xcode-spawned bridge reads it at spawn, so the
 * change applies to the next conversation and needs no sidecar restart. The written value is a
 * route-level override — it is only kept when it differs from the top-level `yolo`, so an on→off→on
 * round trip in the UI restores the file byte for byte.
 *
 * Whole-file rewrite, the same approach as `scripts/setup.ts --write` (key order is preserved).
 * The new text is validated by loading it from a temp file and only then swapped in, so a bad write
 * can never leave a config the bridge cannot start from.
 */
export function writeRouteYolo(configPath: string, route: string, yolo: boolean): void {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    routes?: Record<string, unknown>;
    yolo?: unknown;
  };
  const routes = parsed.routes;
  if (routes === undefined || typeof routes !== "object" || routes === null || Array.isArray(routes)) {
    throw new Error("acp-bridge config: routes is empty");
  }
  const backend = routes[route];
  if (backend === undefined || typeof backend !== "object" || backend === null || Array.isArray(backend)) {
    throw new Error(`acp-bridge config: unknown route ${route}`);
  }
  // A route-level value equal to the top-level default is dropped instead of pinned, so switching a
  // route on→off→on in the dashboard leaves the file exactly as it was.
  if (yolo === (parsed.yolo === true)) {
    delete (backend as Record<string, unknown>).yolo;
  } else {
    (backend as Record<string, unknown>).yolo = yolo;
  }

  const text = `${JSON.stringify(parsed, null, 2)}\n`;
  const tmpPath = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, text, "utf8");
  try {
    loadAcpBridgeConfig(tmpPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
  fs.renameSync(tmpPath, configPath);
}
