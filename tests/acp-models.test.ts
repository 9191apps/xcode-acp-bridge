import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { AcpEventStore } from "../src/acp/event-store";
import { parseModelsOutput } from "../src/acp/models";
import type { AcpBridgeConfig, AcpEvent } from "../src/acp/types";
import { EventHub } from "../src/dashboard/events";
import { createAcpDashboardApp } from "../src/dashboard/acp-routes";

describe("parseModelsOutput", () => {
  test("parses Cursor id - Label lines and skips header", () => {
    const out = parseModelsOutput(`Available models

auto - Auto (default)
composer-2.5 - Composer 2.5
gpt-5.2 - GPT-5.2
`);
    expect(out).toEqual(["auto", "composer-2.5", "gpt-5.2"]);
  });

  test("parses OpenCode one-id-per-line output", () => {
    expect(parseModelsOutput("opencode/big-pickle\ndeepseek/deepseek-chat\n")).toEqual([
      "opencode/big-pickle",
      "deepseek/deepseek-chat",
    ]);
  });

  test("skips Qoder MODEL header and keeps ids", () => {
    expect(parseModelsOutput("MODEL\nQwen3.8-Max\n")).toEqual(["Qwen3.8-Max"]);
  });

  test("skips Cursor Tip footer and keeps id - Label rows", () => {
    const out = parseModelsOutput(`Available models

auto - Auto (default)
composer-2.5 - Composer 2.5

Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'.
`);
    expect(out).toEqual(["auto", "composer-2.5"]);
    expect(out.some((id) => /tip:/i.test(id))).toBe(false);
  });
});

const dir = path.join(import.meta.dir, ".tmp-acp-models");
const eventsPath = path.join(dir, "acp-events.jsonl");
const modelsFixture = path.join(import.meta.dir, "fixtures/acp-fake-models.ts");
const counterPath = path.join(dir, "counter.txt");

function testConfig(): AcpBridgeConfig {
  return {
    routes: {
      opencode: {
        command: "/bin/echo",
        args: ["acp"],
        modelsCommand: { command: process.execPath, args: [modelsFixture, counterPath] },
      },
      broken: {
        command: "/bin/true",
        args: [],
        modelsCommand: { command: "/bin/false", args: [] },
      },
      plain: { command: "/bin/true", args: [] },
    },
    defaultRoute: "opencode",
    defaultBackend: { command: "/bin/echo", args: ["acp"] },
    eventsPath,
    routeStatePath: path.join(dir, "acp-route.json"),
    maxRawBytes: 99,
  };
}

function acpApp(store: AcpEventStore) {
  return createAcpDashboardApp(store, new EventHub(), { config: testConfig() });
}

function sessionNewResultRaw(models: string[]): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      sessionId: "s1",
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: models[0],
          options: models.map((value) => ({ value, name: value })),
        },
      ],
    },
  });
}

function ev(over: Partial<AcpEvent> = {}): AcpEvent {
  return {
    id: "e1",
    ts: new Date().toISOString(),
    kind: "rpc",
    bridgePid: 1,
    backendPid: 2,
    dir: "a2c",
    rpcId: 1,
    method: null,
    sessionHints: [],
    raw: "{}",
    truncated: false,
    parseError: null,
    ...over,
  };
}

beforeEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("GET /api/acp-models", () => {
  test("runs modelsCommand and caches per route", async () => {
    const app = acpApp(new AcpEventStore(eventsPath));
    const first = await (await app.request("http://127.0.0.1/api/acp-models?route=opencode")).json();
    expect(first.models).toEqual(["model-1"]);
    expect(first.source).toBe("command");
    const second = await (await app.request("http://127.0.0.1/api/acp-models?route=opencode")).json();
    expect(second.models).toEqual(["model-1"]); // cached, command ran once
    const refreshed = await (
      await app.request("http://127.0.0.1/api/acp-models?route=opencode&refresh=1")
    ).json();
    expect(refreshed.models).toEqual(["model-2"]);
  });

  test("unknown route returns 400", async () => {
    const app = acpApp(new AcpEventStore(eventsPath));
    const res = await app.request("http://127.0.0.1/api/acp-models?route=nope");
    expect(res.status).toBe(400);
  });

  test("falls back to observed configOptions when no modelsCommand", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "obs-1", route: "plain", raw: sessionNewResultRaw(["m-x", "m-y"]) }));
    const app = acpApp(store);
    const body = await (await app.request("http://127.0.0.1/api/acp-models?route=plain")).json();
    expect(body.models).toEqual(["m-x", "m-y"]);
    expect(body.source).toBe("observed");
  });

  test("observed ignores other routes", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "obs-2", route: "opencode", raw: sessionNewResultRaw(["m-other"]) }));
    const app = acpApp(store);
    const body = await (await app.request("http://127.0.0.1/api/acp-models?route=plain")).json();
    expect(body.models).toEqual([]);
    expect(body.source).toBe("none");
  });

  test("command failure warns and falls back to observed", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "obs-3", route: "broken", raw: sessionNewResultRaw(["m-cached"]) }));
    const app = acpApp(store);
    const body = await (await app.request("http://127.0.0.1/api/acp-models?route=broken")).json();
    expect(body.source).toBe("observed");
    expect(body.models).toEqual(["m-cached"]);
    expect(body.warning).toContain("modelsCommand failed");
  });

  test("current reflects route state model", async () => {
    const app = acpApp(new AcpEventStore(eventsPath));
    await app.request("http://127.0.0.1/api/acp-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "plain", model: "m-x" }),
    });
    const body = await (await app.request("http://127.0.0.1/api/acp-models?route=plain")).json();
    expect(body.current).toBe("m-x");
  });
});
