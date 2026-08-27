import { Hono } from "hono";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationSummary } from "../acp/conversations";
import { writeModelCommand } from "../acp/commands";
import { repoRoot } from "../acp/config";
import { observedModelsFromEvents, runModelsCommand } from "../acp/models";
import { loadAcpRouteState, resolveRoute, writeAcpRouteState } from "../acp/route-state";
import { groupConversationsForList } from "../acp/session-list-group";
import { loadSessionModels, writeSessionModel } from "../acp/session-models";
import type { AcpRouteState } from "../acp/route-state";
import type { AcpBackend, AcpBridgeConfig, AcpResumeMode } from "../acp/types";
import type { AcpEventStore } from "../acp/event-store";
import { contentsDirFromExecPath, resolveAcpPathLayout } from "../acp/paths";
import {
  checkAgentAuth,
  checkQodercliAuth,
  detectBackendBinary,
  hasExecutable,
} from "../setup-check";
import packageJson from "../../package.json";
import { EventHub } from "./events";
import { createTtlCache } from "./ttl-cache";

const PRODUCT = "xcode-acp-bridge";
const VERSION = packageJson.version;

export type AcpDashboardDeps = {
  config: AcpBridgeConfig;
  /** Overrides the (process-spawning) backend detection for tests. */
  probeBackends?: (config: AcpBridgeConfig) => BackendStatusEntry[];
  openTerminal?: (
    bin: string,
    sessionId: string,
    cwd: string | null,
    resumeArgs?: string[],
    resumeMode?: AcpResumeMode,
  ) => void;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const DEFAULT_RESUME_ARGS = ["-s", "{sessionId}"];

export function expandResumeArgs(resumeArgs: string[], sessionId: string): string[] {
  return resumeArgs.map((arg) => arg.replaceAll("{sessionId}", sessionId));
}

type ResumePathOptions = Parameters<typeof resolveAcpPathLayout>[0];

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** …/Contents/MacOS/<name>, derived from a …/Contents/Resources path. */
function macOSSiblingOfResources(resources: string, name: string): string | null {
  if (path.basename(resources) !== "Resources") return null;
  return path.join(path.dirname(resources), "MacOS", name);
}

function acpResumeHelperPath(name: "cursor-acp-resume" | "qoder-acp-resume", opts?: ResumePathOptions): string {
  const layout = resolveAcpPathLayout(opts);
  // `build-app.sh` ships the compiled helpers in Contents/MacOS beside the app
  // launcher, so the bundle has to be found from either end: the packaged shell
  // launches acp-serve with ACP_BRIDGE_* set (layout mode "env", bundle known
  // only via ACP_BRIDGE_RESOURCES), while a directly-launched bundled binary
  // gets mode "app" (bundle known via execPath). Resources/bin stays first so a
  // future non-bundle install layout keeps working.
  const contentsFromExecPath = contentsDirFromExecPath(opts?.execPath ?? process.execPath);
  const candidates = [
    path.join(layout.resources, "bin", name),
    macOSSiblingOfResources(layout.resources, name),
    contentsFromExecPath ? path.join(contentsFromExecPath, "MacOS", name) : null,
  ];
  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }

  return path.join(repoRoot(), "src", "acp", `${name}.ts`);
}

export function cursorAcpResumeScriptPath(opts?: ResumePathOptions): string {
  return acpResumeHelperPath("cursor-acp-resume", opts);
}

export function qoderAcpResumeScriptPath(opts?: ResumePathOptions): string {
  return acpResumeHelperPath("qoder-acp-resume", opts);
}

/** Build the argv used inside the Terminal .command script for a route resume. */
export function buildResumeLaunchArgs(
  backend: Pick<AcpBackend, "command" | "resumeArgs" | "resumeMode">,
  sessionId: string,
  cwd: string | null,
  opts?: ResumePathOptions,
): { bin: string; argv: string[] } {
  const mode = backend.resumeMode ?? "args";
  if (mode === "cursor-acp-load") {
    const helperPath = cursorAcpResumeScriptPath(opts);
    const argv = [
      "--agent",
      backend.command,
      "--session-id",
      sessionId,
    ];
    if (cwd) argv.push("--cwd", cwd);
    return helperPath.endsWith(".ts")
      ? { bin: process.execPath, argv: [helperPath, ...argv] }
      : { bin: helperPath, argv };
  }
  if (mode === "qoder-acp-load") {
    const helperPath = qoderAcpResumeScriptPath(opts);
    const argv = [
      "--agent",
      backend.command,
      "--session-id",
      sessionId,
    ];
    if (cwd) argv.push("--cwd", cwd);
    return helperPath.endsWith(".ts")
      ? { bin: process.execPath, argv: [helperPath, ...argv] }
      : { bin: helperPath, argv };
  }
  return {
    bin: backend.command,
    argv: expandResumeArgs(backend.resumeArgs ?? DEFAULT_RESUME_ARGS, sessionId),
  };
}

// Write an executable .command file and hand it to Terminal.app so the old
// conversation (which Xcode may no longer list) can be resumed in the ACP tool.
export function openTerminalResume(
  bin: string,
  sessionId: string,
  cwd: string | null,
  resumeArgs: string[] = DEFAULT_RESUME_ARGS,
  resumeMode: AcpResumeMode = "args",
): void {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
  const scriptPath = path.join(os.tmpdir(), `acp-resume-${safe}.command`);
  const { bin: launchBin, argv } = buildResumeLaunchArgs(
    { command: bin, resumeArgs, resumeMode },
    sessionId,
    cwd,
  );
  // ACP resume helpers already pass --cwd; for args mode, cd into project first.
  const cd = resumeMode === "args" && cwd ? `cd ${shellQuote(cwd)} || exit 1\n` : "";
  const cmd = [launchBin, ...argv].map(shellQuote).join(" ");
  fs.writeFileSync(scriptPath, `#!/bin/bash\n${cd}exec ${cmd}\n`, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  Bun.spawn(["open", "-a", "Terminal", scriptPath], { stdout: "ignore", stderr: "ignore" });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Request metadata captured for every model-write PUT, so a mystery write is
// attributable: which browser/tool sent it and when. Written to both stdout
// (server console) and a JSONL file next to the events data for later review.
function modelPutLogPath(config: AcpBridgeConfig): string {
  return path.join(path.dirname(config.eventsPath), "acp-model-puts.jsonl");
}

function requestMeta(c: Context): Record<string, unknown> {
  return {
    userAgent: c.req.header("user-agent") ?? null,
    origin: c.req.header("origin") ?? null,
    referer: c.req.header("referer") ?? null,
  };
}

function logModelPut(config: AcpBridgeConfig, entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  console.log(`[acp] ${line}`);
  try {
    const filePath = modelPutLogPath(config);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${line}\n`, "utf8");
  } catch (err) {
    console.error(`[acp] model-put log write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function overlayStoredModel<T extends ConversationSummary>(row: T, stored: Record<string, string>): T {
  const model = row.acpSessionId ? stored[row.acpSessionId] : undefined;
  return model ? { ...row, model } : row;
}

// A conversation whose bridge process is gone without a process_end event
// (killed/crashed) is neither live nor cleanly ended. The event-derived status
// stays "live" forever in that case; reconcile it against the live process so
// the UI does not imply a live model switch is possible.
function withLiveStatus<T extends Pick<ConversationSummary, "bridgePid" | "status">>(row: T): T {
  if (row.status !== "live") return row;
  return processAlive(row.bridgePid) ? row : { ...row, status: "stale" };
}

function routeResponse(config: AcpBridgeConfig): {
  route: string;
  defaultRoute: string;
  routes: string[];
  source: "state" | "default";
  model: string | null;
} {
  const state = loadAcpRouteState(config.routeStatePath);
  const resolved = resolveRoute(config, state);
  const model = resolved.fallbackReason === null && state ? (state.model ?? null) : null;
  return {
    route: resolved.name,
    defaultRoute: config.defaultRoute,
    routes: Object.keys(config.routes),
    source: resolved.fallbackReason === null ? "state" : "default",
    model,
  };
}

export type BackendStatusEntry = {
  name: string;
  command: string;
  executable: boolean;
  auth?: { ok: boolean; authenticated: boolean; detail: string };
};

/**
 * How long a backend probe result is reused. Each probe shells out
 * synchronously (`which`, plus `agent status` / `qodercli status`, each up to
 * an 8s timeout), so an uncached `/api/app/status` can block the event loop for
 * seconds. The menu bar re-reads this endpoint on every open, and backend
 * install/login state changes on a human timescale, so a 90s window keeps the
 * menu honest while collapsing bursts of opens into one probe. Keep this TTL
 * comfortably above the menu bar poll interval so SSE is not stalled by
 * synchronous `spawnSync` auth probes on every refresh tick.
 */
export const APP_STATUS_PROBE_TTL_MS = 90_000;

function probeBackends(config: AcpBridgeConfig): BackendStatusEntry[] {
  return Object.entries(config.routes).map(([name, backend]) => {
    const detected = detectBackendBinary(name, backend.command);
    const command = detected ?? backend.command;
    const base = path.basename(backend.command);
    const status: BackendStatusEntry = {
      name,
      command,
      executable: hasExecutable(command),
    };
    if (name === "cursor" || base === "agent" || base === "cursor-agent") {
      status.auth = checkAgentAuth(command);
    } else if (name === "qodercli" || base === "qodercli" || base === "qoder") {
      status.auth = checkQodercliAuth(command);
    }
    return status;
  });
}

export function createAcpDashboardApp(
  store: AcpEventStore,
  hub?: EventHub,
  deps?: AcpDashboardDeps,
): Hono {
  if (!deps) {
    throw new Error("createAcpDashboardApp requires deps");
  }
  const { config } = deps;
  const eventHub = hub ?? new EventHub();
  const app = new Hono();

  store.subscribe((event) => eventHub.publishNamed("acp", event));

  app.get("/health", (c) => {
    return c.json({ ok: true, product: PRODUCT, version: VERSION });
  });

  // Route/model stay live (a cheap JSON read); only the process-spawning
  // backend probes are cached. See APP_STATUS_PROBE_TTL_MS.
  const probe = deps.probeBackends ?? probeBackends;
  const backendStatusCache = createTtlCache({
    ttlMs: APP_STATUS_PROBE_TTL_MS,
    load: () => probe(config),
  });

  app.get("/api/app/status", (c) => {
    const route = routeResponse(config);
    const backends = backendStatusCache.get();
    const ok = backends.every(
      (backend) =>
        backend.executable &&
        (backend.auth === undefined || (backend.auth.ok && backend.auth.authenticated)),
    );
    return c.json({
      ok,
      product: PRODUCT,
      version: VERSION,
      route: route.route,
      model: route.model,
      routes: route.routes,
      backends,
      layoutMode: resolveAcpPathLayout().mode,
    });
  });

  app.get("/api/acp-events", (c) => c.json(store.list()));

  app.get("/acp-events", (c) => {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    return stream(c, async (s) => {
      const body = eventHub.subscribe();
      const reader = body.getReader();
      // WKWebView / idle proxies drop quiet SSE streams. Comment frames are
      // ignored by EventSource but keep the socket alive.
      const heartbeat = setInterval(() => {
        void s.write(": ping\n\n");
      }, 5_000);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          await s.write(value);
        }
      } finally {
        clearInterval(heartbeat);
        reader.releaseLock();
      }
    });
  });

  app.post("/api/acp-events/clear", async (c) => {
    await store.clear();
    return c.json({ ok: true });
  });

  app.get("/api/acp-events/export", async (c) => {
    const json = JSON.stringify(await store.exportAll(), null, 2);
    return new Response(json, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": "attachment; filename=acp-events-export.json",
      },
    });
  });

  app.get("/api/acp-events/:id", (c) => {
    const event = store.getById(c.req.param("id"));
    if (!event) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(event);
  });

  app.get("/api/acp-route", (c) => {
    return c.json(routeResponse(config));
  });

  app.put("/api/acp-route", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "unknown route" }, 400);
    }
    const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const route = rec.route;
    if (typeof route !== "string" || !(route in config.routes)) {
      return c.json({ error: "unknown route" }, 400);
    }
    const model = rec.model;
    if (model !== undefined && model !== null && typeof model !== "string") {
      return c.json({ error: "invalid model" }, 400);
    }
    const state: AcpRouteState = { route };
    if (typeof model === "string" && model.length > 0) {
      state.model = model;
    }
    writeAcpRouteState(config.routeStatePath, state);
    logModelPut(config, { endpoint: "route-state", route, model: state.model ?? null, outcome: "ok", ...requestMeta(c) });
    return c.json({ ...routeResponse(config), source: "state" as const });
  });

  app.get("/api/acp-conversations/:bridgePid", (c) => {
    const pid = Number(c.req.param("bridgePid"));
    if (Number.isNaN(pid)) {
      return c.json({ error: "not found" }, 404);
    }
    const detail = store.detail(pid);
    if (!detail) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(withLiveStatus(overlayStoredModel(detail, loadSessionModels(config.eventsPath))));
  });

  app.delete("/api/acp-conversations/:bridgePid", async (c) => {
    const pid = Number(c.req.param("bridgePid"));
    if (Number.isNaN(pid)) {
      return c.json({ error: "not found" }, 404);
    }
    const removed = await store.deleteByPid(pid);
    if (!removed) {
      return c.json({ error: "not found" }, 404);
    }
    eventHub.publishNamed("acp", { id: `deleted-${pid}`, kind: "deleted", bridgePid: pid });
    return c.json({ ok: true, bridgePid: pid });
  });

  app.put("/api/acp-conversations/:bridgePid/model", async (c) => {
    const pid = Number(c.req.param("bridgePid"));
    if (Number.isNaN(pid)) {
      return c.json({ error: "not found" }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      logModelPut(config, { endpoint: "conversation-model", bridgePid: pid, model: null, outcome: "invalid json", ...requestMeta(c) });
      return c.json({ error: "invalid model" }, 400);
    }
    const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const model = rec.model;
    if (typeof model !== "string" || model.length === 0) {
      logModelPut(config, { endpoint: "conversation-model", bridgePid: pid, model: typeof model === "string" ? model : null, outcome: "invalid model", ...requestMeta(c) });
      return c.json({ error: "invalid model" }, 400);
    }
    const detail = store.detail(pid);
    if (!detail) {
      logModelPut(config, { endpoint: "conversation-model", bridgePid: pid, model, outcome: "not found", ...requestMeta(c) });
      return c.json({ error: "not found" }, 404);
    }
    const liveRunning = detail.status === "live" && processAlive(pid);
    if (liveRunning) {
      writeModelCommand(config.eventsPath, pid, model);
    }
    const common = { endpoint: "conversation-model", bridgePid: pid, model, acpSessionId: detail.acpSessionId, status: detail.status, liveRunning, ...requestMeta(c) };
    if (detail.acpSessionId) {
      writeSessionModel(config.eventsPath, detail.acpSessionId, model);
      logModelPut(config, { ...common, wroteCommand: liveRunning, wroteSessionModel: true, outcome: "ok" });
      return c.json({ ok: true, bridgePid: pid, model });
    }
    if (liveRunning) {
      logModelPut(config, { ...common, wroteCommand: true, wroteSessionModel: false, outcome: "ok (no session id)" });
      return c.json({ ok: true, bridgePid: pid, model });
    }
    if (detail.status !== "live") {
      logModelPut(config, { ...common, outcome: "409 no session id" });
      return c.json({ error: "no session id" }, 409);
    }
    logModelPut(config, { ...common, outcome: "409 not live" });
    return c.json({ error: "conversation not live" }, 409);
  });

  app.post("/api/acp-conversations/:bridgePid/resume", (c) => {
    const pid = Number(c.req.param("bridgePid"));
    if (Number.isNaN(pid)) {
      return c.json({ error: "not found" }, 404);
    }
    const detail = store.detail(pid);
    if (!detail) {
      return c.json({ error: "not found" }, 404);
    }
    if (!detail.acpSessionId) {
      return c.json({ error: "no session id" }, 409);
    }
    const backend = detail.route ? config.routes[detail.route] : undefined;
    if (!backend) {
      return c.json({ error: "no route for this conversation" }, 409);
    }
    try {
      const openTerminal = deps?.openTerminal ?? openTerminalResume;
      openTerminal(
        backend.command,
        detail.acpSessionId,
        detail.cwd,
        backend.resumeArgs ?? DEFAULT_RESUME_ARGS,
        backend.resumeMode ?? "args",
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    return c.json({ ok: true, sessionId: detail.acpSessionId });
  });

  const modelsCache = new Map<string, string[]>();

  app.get("/api/acp-models", async (c) => {
    const route = c.req.query("route") ?? "";
    const refresh = c.req.query("refresh") === "1";
    if (!(route in config.routes)) {
      return c.json({ error: "unknown route" }, 400);
    }
    const backend = config.routes[route]!;
    const state = loadAcpRouteState(config.routeStatePath);
    const current = state && state.route === route && typeof state.model === "string" ? state.model : null;

    let models: string[] | null = null;
    let source: "command" | "observed" | "none" = "none";
    let warning: string | undefined;

    if (backend.modelsCommand) {
      const cached = modelsCache.get(route);
      if (cached && !refresh) {
        models = cached;
        source = "command";
      } else {
        try {
          models = await runModelsCommand(backend.modelsCommand);
          modelsCache.set(route, models);
          source = "command";
        } catch (err) {
          warning = `modelsCommand failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
    if (models === null) {
      const observed = observedModelsFromEvents(store.list(), route);
      if (observed.length > 0) {
        models = observed;
        source = "observed";
      } else {
        models = [];
      }
    }
    return c.json({ route, models, source, warning, current });
  });

  app.get("/api/acp-conversations", (c) => {
    const stored = loadSessionModels(config.eventsPath);
    return c.json(store.summaries().map((row) => withLiveStatus(overlayStoredModel(row, stored))));
  });

  app.get("/api/acp-conversation-sessions", (c) => {
    const stored = loadSessionModels(config.eventsPath);
    const rows = store.summaries().map((row) => withLiveStatus(overlayStoredModel(row, stored)));
    const groups = groupConversationsForList(rows).map((g) => {
      if (g.kind === "singleton") return g;
      const { representative, ...rest } = g;
      return {
        ...rest,
        representativeBridgePid: representative.bridgePid,
      };
    });
    return c.json(groups);
  });

  return app;
}
