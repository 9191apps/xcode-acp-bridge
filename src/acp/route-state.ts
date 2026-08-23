import fs from "node:fs";
import path from "node:path";
import type { AcpBackend, AcpBridgeConfig } from "./types";

export type AcpRouteState = { route: string; model?: string };

export function loadAcpRouteState(filePath: string): AcpRouteState | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed.route !== "string" || parsed.route === "") {
      return null;
    }
    const state: AcpRouteState = { route: parsed.route };
    if (typeof parsed.model === "string" && parsed.model.length > 0) {
      state.model = parsed.model;
    }
    return state;
  } catch {
    return null;
  }
}

export function writeAcpRouteState(filePath: string, state: AcpRouteState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state) + "\n", "utf8");
}

export function resolveRoute(
  config: AcpBridgeConfig,
  state: AcpRouteState | null,
): { name: string; backend: AcpBackend; fallbackReason: "missing" | "unknown_route" | null } {
  if (state?.route && state.route in config.routes) {
    const name = state.route;
    return { name, backend: config.routes[name], fallbackReason: null };
  }

  const name = config.defaultRoute;
  const fallbackReason = state === null ? "missing" : "unknown_route";
  return { name, backend: config.routes[name], fallbackReason };
}
