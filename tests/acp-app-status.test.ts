import { describe, expect, test } from "bun:test";
import path from "node:path";
import { AcpEventStore } from "../src/acp/event-store";
import type { AcpBridgeConfig } from "../src/acp/types";
import { createAcpDashboardApp } from "../src/dashboard/acp-routes";
import { EventHub } from "../src/dashboard/events";

const dir = path.join(import.meta.dir, ".tmp-acp-app-status");

function testConfig(): AcpBridgeConfig {
  return {
    routes: {
      opencode: { command: "/bin/echo", args: ["acp"] },
      cursor: { command: "/bin/echo", args: ["acp"] },
    },
    defaultRoute: "opencode",
    defaultBackend: { command: "/bin/echo", args: ["acp"] },
    eventsPath: path.join(dir, "acp-events.jsonl"),
    routeStatePath: path.join(dir, "acp-route.json"),
    maxRawBytes: 99,
  };
}

function app() {
  const config = testConfig();
  return createAcpDashboardApp(new AcpEventStore(config.eventsPath), new EventHub(), { config });
}

describe("app status", () => {
  test("GET /health returns the product fingerprint and package version", async () => {
    const res = await app().request("http://127.0.0.1/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      product: "xcode-acp-bridge",
      version: "0.1.0",
    });
  });

  test("GET /api/app/status returns route, backend, and layout status", async () => {
    const res = await app().request("http://127.0.0.1/api/app/status");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["ok", "product", "version", "route", "model", "routes", "backends", "layoutMode"].sort(),
    );
    expect(body.product).toBe("xcode-acp-bridge");
    expect(body.version).toBe("0.1.0");
    expect(body.route).toBe("opencode");
    expect(body.model).toBeNull();
    expect(body.routes).toEqual(["opencode", "cursor"]);
    expect(typeof body.ok).toBe("boolean");
    expect(["env", "app", "repo"]).toContain(body.layoutMode);
    expect(body.backends).toHaveLength(2);
    expect(body.backends.map((backend: { name: string }) => backend.name)).toEqual([
      "opencode",
      "cursor",
    ]);
    expect(typeof body.backends[0].command).toBe("string");
    expect(typeof body.backends[0].executable).toBe("boolean");
    expect(body.backends[0].auth).toBeUndefined();
    expect(Object.keys(body.backends[1].auth).sort()).toEqual(
      ["ok", "authenticated", "detail"].sort(),
    );
    expect(typeof body.backends[1].auth.ok).toBe("boolean");
    expect(typeof body.backends[1].auth.authenticated).toBe("boolean");
    expect(typeof body.backends[1].auth.detail).toBe("string");
  });
});
