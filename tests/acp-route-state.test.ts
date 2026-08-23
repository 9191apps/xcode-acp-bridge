import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AcpBridgeConfig } from "../src/acp/types";
import { loadAcpRouteState, resolveRoute, writeAcpRouteState } from "../src/acp/route-state";

const dir = path.join(import.meta.dir, ".tmp-acp-route");
const filePath = path.join(dir, "acp-route.json");

const config: AcpBridgeConfig = {
  routes: {
    opencode: { command: "/bin/echo", args: ["acp"] },
    other: { command: "/bin/true", args: [] },
  },
  defaultRoute: "opencode",
  defaultBackend: { command: "/bin/echo", args: ["acp"] },
  eventsPath: "/tmp/e.jsonl",
  routeStatePath: filePath,
  maxRawBytes: 1,
};

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadAcpRouteState", () => {
  test("missing file returns null", () => {
    expect(loadAcpRouteState(filePath)).toBeNull();
  });

  test("valid file returns route", () => {
    fs.writeFileSync(filePath, JSON.stringify({ route: "other" }));
    expect(loadAcpRouteState(filePath)).toEqual({ route: "other" });
  });

  test("invalid json returns null", () => {
    fs.writeFileSync(filePath, "{nope");
    expect(loadAcpRouteState(filePath)).toBeNull();
  });

  test("missing route string returns null", () => {
    fs.writeFileSync(filePath, JSON.stringify({}));
    expect(loadAcpRouteState(filePath)).toBeNull();
  });

  test("keeps model when it is a non-empty string", () => {
    fs.writeFileSync(filePath, JSON.stringify({ route: "other", model: "m-x" }));
    expect(loadAcpRouteState(filePath)).toEqual({ route: "other", model: "m-x" });
  });

  test("drops model when empty or non-string", () => {
    fs.writeFileSync(filePath, JSON.stringify({ route: "other", model: "" }));
    expect(loadAcpRouteState(filePath)).toEqual({ route: "other" });
    fs.writeFileSync(filePath, JSON.stringify({ route: "other", model: 42 }));
    expect(loadAcpRouteState(filePath)).toEqual({ route: "other" });
  });
});

describe("writeAcpRouteState", () => {
  test("creates parent dirs and round-trips", () => {
    const nested = path.join(dir, "nested", "acp-route.json");
    writeAcpRouteState(nested, { route: "opencode" });
    expect(loadAcpRouteState(nested)).toEqual({ route: "opencode" });
  });

  test("round-trips model", () => {
    writeAcpRouteState(filePath, { route: "opencode", model: "m-y" });
    expect(loadAcpRouteState(filePath)).toEqual({ route: "opencode", model: "m-y" });
  });
});

describe("resolveRoute", () => {
  test("state wins when the name exists", () => {
    const r = resolveRoute(config, { route: "other" });
    expect(r.name).toBe("other");
    expect(r.backend.command).toBe("/bin/true");
    expect(r.fallbackReason).toBeNull();
  });

  test("missing state uses defaultRoute", () => {
    const r = resolveRoute(config, null);
    expect(r.name).toBe("opencode");
    expect(r.fallbackReason).toBe("missing");
  });

  test("unknown state name uses defaultRoute", () => {
    const r = resolveRoute(config, { route: "nope" });
    expect(r.name).toBe("opencode");
    expect(r.fallbackReason).toBe("unknown_route");
  });
});
