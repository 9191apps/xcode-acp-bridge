import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { commandsDirFor, readModelCommand } from "../src/acp/commands";
import { lookupSessionModel } from "../src/acp/session-models";
import { loadAcpBridgeConfig } from "../src/acp/config";
import { AcpEventStore } from "../src/acp/event-store";
import type { AcpBridgeConfig, AcpEvent } from "../src/acp/types";
import { startAcpTail } from "../src/acp/tail";
import { EventHub } from "../src/dashboard/events";
import { createAcpDashboardApp } from "../src/dashboard/acp-routes";

const dir = path.join(import.meta.dir, ".tmp-acp-dash");
const eventsPath = path.join(dir, "acp-events.jsonl");

function testConfig(): AcpBridgeConfig {
  return {
    routes: {
      opencode: { command: "/bin/echo", args: ["acp"] },
      other: { command: "/bin/true", args: [] },
      cursor: {
        command: "/bin/echo",
        args: ["acp"],
        modelApply: "spawn-arg",
        resumeMode: "cursor-acp-load",
        resumeArgs: ["--resume", "{sessionId}"],
      },
    },
    defaultRoute: "opencode",
    defaultBackend: { command: "/bin/echo", args: ["acp"] },
    eventsPath,
    routeStatePath: path.join(dir, "acp-route.json"),
    maxRawBytes: 99,
  };
}

function acpApp(store: AcpEventStore, hub?: EventHub) {
  return createAcpDashboardApp(store, hub ?? new EventHub(), { config: testConfig() });
}

function acpAppWithOpenTerminal(
  store: AcpEventStore,
  openTerminal: (
    bin: string,
    sessionId: string,
    cwd: string | null,
    resumeArgs?: string[],
    resumeMode?: string,
  ) => void,
  config: AcpBridgeConfig = testConfig(),
) {
  return createAcpDashboardApp(store, new EventHub(), { config, openTerminal });
}

function ev(over: Partial<AcpEvent> = {}): AcpEvent {
  return {
    id: "e1",
    ts: new Date().toISOString(),
    kind: "rpc",
    bridgePid: 1,
    backendPid: 2,
    dir: "c2a",
    rpcId: 0,
    method: "initialize",
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

describe("acp dashboard api", () => {
  test("GET /api/acp-events lists appended events", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "dash-1", method: "session/new" }));
    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-events");
    const body = await res.json();
    expect(body.length).toBe(1);
    expect(body[0].id).toBe("dash-1");
    expect(body[0].method).toBe("session/new");
  });

  test("SSE /acp-events receives event: acp with matching id", async () => {
    const store = new AcpEventStore(eventsPath);
    const hub = new EventHub();
    const app = acpApp(store, hub);

    const ac = new AbortController();
    const res = await app.request("http://127.0.0.1/acp-events", { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const appendPromise = store.append(ev({ id: "sse-acp-1" }));

    let eventText = "";
    while (!eventText.includes("event: acp")) {
      const { value, done } = await reader.read();
      if (done) break;
      eventText += decoder.decode(value);
    }
    await appendPromise;

    expect(eventText).toContain('"id":"sse-acp-1"');

    ac.abort();
    try {
      await reader.cancel();
    } catch {
      // abort may already close the reader
    }
  });

  test("SSE /acp-events receives tail-appended file event once", async () => {
    const store = new AcpEventStore(eventsPath);
    const hub = new EventHub();
    const stopTail = startAcpTail(store, (e) => hub.publishNamed("acp", e));
    const app = acpApp(store, hub);

    const ac = new AbortController();
    const res = await app.request("http://127.0.0.1/acp-events", { signal: ac.signal });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // External writer appends to a conversation file in the shard dir.
    await fs.mkdir(store.dir, { recursive: true });
    const fileEvent = ev({ id: "tail-file-1", method: "session/update", bridgePid: 1 });
    await fs.appendFile(path.join(store.dir, "1-test.jsonl"), `${JSON.stringify(fileEvent)}\n`, "utf8");

    let eventText = "";
    const deadline = Date.now() + 3000;
    while (!eventText.includes('"id":"tail-file-1"') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      eventText += decoder.decode(value);
    }

    const matches = eventText.match(/event: acp/g) ?? [];
    expect(matches.length).toBe(1);
    expect(eventText).toContain('"id":"tail-file-1"');

    ac.abort();
    stopTail();
    try {
      await reader.cancel();
    } catch {
      // abort may already close the reader
    }
  });

  test("POST /api/acp-events/clear empties list and deletes shard dir", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "clear-me" }));
    await fs.access(store.dir);

    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-events/clear", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const listRes = await app.request("http://127.0.0.1/api/acp-events");
    expect(await listRes.json()).toEqual([]);

    await expect(fs.access(store.dir)).rejects.toThrow();
  });

  test("GET /api/acp-events/export returns JSON attachment", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "export-1", method: "session/prompt" }));

    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-events/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("acp-events-export.json");

    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("export-1");
    expect(body[0].method).toBe("session/prompt");
  });

  test("GET /api/acp-events/:id returns one event", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "one-event", raw: '{"hello":1}', method: "session/prompt" }));
    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-events/one-event");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("one-event");
    expect(body.raw).toBe('{"hello":1}');
  });

  test("GET /api/acp-events/:id 404s when missing", async () => {
    const store = new AcpEventStore(eventsPath);
    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-events/nope");
    expect(res.status).toBe(404);
  });

  test("GET /api/acp-route falls back to defaultRoute", async () => {
    const store = new AcpEventStore(eventsPath);
    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-route");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.route).toBe("opencode");
    expect(body.source).toBe("default");
    expect(body.routes).toContain("other");
  });

  test("PUT /api/acp-route persists and GET reads it", async () => {
    const store = new AcpEventStore(eventsPath);
    const app = acpApp(store);
    const put = await app.request("http://127.0.0.1/api/acp-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "other" }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).source).toBe("state");
    const get = await app.request("http://127.0.0.1/api/acp-route");
    expect((await get.json()).route).toBe("other");
  });

  test("PUT unknown route returns 400 and does not write", async () => {
    const store = new AcpEventStore(eventsPath);
    const app = acpApp(store);
    const put = await app.request("http://127.0.0.1/api/acp-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "nope" }),
    });
    expect(put.status).toBe(400);
    const get = await app.request("http://127.0.0.1/api/acp-route");
    expect((await get.json()).route).toBe("opencode");
  });

  test("PUT /api/acp-route persists model and GET returns it", async () => {
    const store = new AcpEventStore(eventsPath);
    const app = acpApp(store);
    const put = await app.request("http://127.0.0.1/api/acp-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "other", model: "m-1" }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).model).toBe("m-1");
    const get = await (await app.request("http://127.0.0.1/api/acp-route")).json();
    expect(get.route).toBe("other");
    expect(get.model).toBe("m-1");
  });

  test("PUT without model clears the selection", async () => {
    const store = new AcpEventStore(eventsPath);
    const app = acpApp(store);
    await app.request("http://127.0.0.1/api/acp-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "other", model: "m-1" }),
    });
    await app.request("http://127.0.0.1/api/acp-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "other" }),
    });
    const get = await (await app.request("http://127.0.0.1/api/acp-route")).json();
    expect(get.model).toBeNull();
  });

  test("PUT with non-string model returns 400", async () => {
    const store = new AcpEventStore(eventsPath);
    const app = acpApp(store);
    const put = await app.request("http://127.0.0.1/api/acp-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "other", model: 42 }),
    });
    expect(put.status).toBe(400);
  });

  test("GET /api/acp-conversations groups events", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid: 42,
        route: "opencode",
        raw: JSON.stringify({ route: "opencode" }),
      }),
    );
    const app = acpApp(store);
    const body = await (await app.request("http://127.0.0.1/api/acp-conversations")).json();
    expect(body).toHaveLength(1);
    expect(body[0].bridgePid).toBe(42);
  });

  test("GET /api/acp-conversations/:pid 404s when missing", async () => {
    const store = new AcpEventStore(eventsPath);
    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-conversations/999");
    expect(res.status).toBe(404);
  });

  test("GET marks live-looking conversations with a dead bridge process as stale", async () => {
    const store = new AcpEventStore(eventsPath);
    const deadPid = 2_147_483_647;
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid: deadPid,
        route: "opencode",
        raw: JSON.stringify({ route: "opencode" }),
      }),
    );
    const app = acpApp(store);
    const detail = await (
      await app.request(`http://127.0.0.1/api/acp-conversations/${deadPid}`)
    ).json();
    expect(detail.status).toBe("stale");
    const listed = await (await app.request("http://127.0.0.1/api/acp-conversations")).json();
    expect(listed[0].status).toBe("stale");
  });

  test("GET keeps live status when the bridge process is alive", async () => {
    const store = new AcpEventStore(eventsPath);
    const pid = process.pid;
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid: pid,
        route: "opencode",
        raw: JSON.stringify({ route: "opencode" }),
      }),
    );
    const app = acpApp(store);
    const detail = await (await app.request(`http://127.0.0.1/api/acp-conversations/${pid}`)).json();
    expect(detail.status).toBe("live");
  });

  test("PUT /api/acp-conversations/:pid/model writes command file for live sessions", async () => {
    const store = new AcpEventStore(eventsPath);
    const bridgePid = process.pid;
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid,
        route: "opencode",
        raw: JSON.stringify({ route: "opencode" }),
      }),
    );
    const app = acpApp(store);
    const res = await app.request(`http://127.0.0.1/api/acp-conversations/${bridgePid}/model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixture/model-b" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, bridgePid, model: "fixture/model-b" });
    const dest = path.join(commandsDirFor(eventsPath), `${bridgePid}.json`);
    expect(readModelCommand(dest)?.model).toBe("fixture/model-b");
  });

  test("PUT live model does not write route state", async () => {
    const store = new AcpEventStore(eventsPath);
    const bridgePid = process.pid;
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid,
        route: "opencode",
        raw: JSON.stringify({ route: "opencode" }),
      }),
    );
    const app = acpApp(store);
    await app.request(`http://127.0.0.1/api/acp-conversations/${bridgePid}/model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixture/model-b" }),
    });
    const statePath = path.join(dir, "acp-route.json");
    expect(await fs.exists(statePath)).toBe(false);
  });

  test("PUT /api/acp-conversations/:pid/model 409s when the bridge process is not alive", async () => {
    const store = new AcpEventStore(eventsPath);
    const deadPid = 2_147_483_646;
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid: deadPid,
        route: "opencode",
        raw: JSON.stringify({ route: "opencode" }),
      }),
    );
    const app = acpApp(store);
    const res = await app.request(`http://127.0.0.1/api/acp-conversations/${deadPid}/model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixture/model-b" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("conversation not live");
    const dest = path.join(commandsDirFor(eventsPath), `${deadPid}.json`);
    expect(await fs.exists(dest)).toBe(false);
  });

  test("PUT /api/acp-conversations/:pid/model stores session model for ended conversations", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid: 42,
        route: "opencode",
        raw: JSON.stringify({ route: "opencode" }),
      }),
    );
    await store.append(
      ev({
        id: "r",
        kind: "rpc",
        dir: "a2c",
        bridgePid: 42,
        method: "session/new",
        sessionHints: ["sess-ended"],
      }),
    );
    await store.append(ev({ id: "e", kind: "process_end", bridgePid: 42 }));
    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-conversations/42/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixture/model-b" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, bridgePid: 42, model: "fixture/model-b" });
    expect(lookupSessionModel(eventsPath, "sess-ended")).toBe("fixture/model-b");
    expect(await fs.exists(path.join(commandsDirFor(eventsPath), "42.json"))).toBe(false);
    expect(await fs.exists(path.join(dir, "acp-route.json"))).toBe(false);
    const listed = await (await app.request("http://127.0.0.1/api/acp-conversations")).json();
    expect(listed[0].model).toBe("fixture/model-b");
  });

  test("PUT /api/acp-conversations/:pid/model 409s when ended without session id", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid: 42,
        route: "opencode",
        raw: JSON.stringify({ route: "opencode" }),
      }),
    );
    await store.append(ev({ id: "e", kind: "process_end", bridgePid: 42 }));
    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-conversations/42/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixture/model-b" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no session id");
  });

  test("PUT live model also persists by session id for resume", async () => {
    const store = new AcpEventStore(eventsPath);
    const bridgePid = process.pid;
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid,
        route: "opencode",
        raw: JSON.stringify({ route: "opencode" }),
      }),
    );
    await store.append(
      ev({
        id: "r",
        kind: "rpc",
        dir: "a2c",
        bridgePid,
        method: "session/new",
        sessionHints: ["sess-live"],
      }),
    );
    const app = acpApp(store);
    const res = await app.request(`http://127.0.0.1/api/acp-conversations/${bridgePid}/model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixture/model-b" }),
    });
    expect(res.status).toBe(200);
    expect(lookupSessionModel(eventsPath, "sess-live")).toBe("fixture/model-b");
  });

  test("PUT /api/acp-conversations/:pid/model 404s when missing", async () => {
    const store = new AcpEventStore(eventsPath);
    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-conversations/999/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixture/model-b" }),
    });
    expect(res.status).toBe(404);
  });

  test("POST /api/acp-conversations/:pid/resume opens terminal with the route binary", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid: 42,
        route: "opencode",
        raw: JSON.stringify({ route: "opencode" }),
      }),
    );
    await store.append(
      ev({
        id: "r",
        kind: "rpc",
        dir: "a2c",
        bridgePid: 42,
        cwd: "/some/project",
        sessionHints: ["sess-resume-1"],
      }),
    );
    const opened: Array<[string, string, string | null, string[] | undefined, string | undefined]> = [];
    const app = acpAppWithOpenTerminal(store, (bin, sessionId, cwd, resumeArgs, resumeMode) => {
      opened.push([bin, sessionId, cwd, resumeArgs, resumeMode]);
    });
    const res = await app.request("http://127.0.0.1/api/acp-conversations/42/resume", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionId: "sess-resume-1" });
    expect(opened).toEqual([
      ["/bin/echo", "sess-resume-1", "/some/project", ["-s", "{sessionId}"], "args"],
    ]);
  });

  test("POST resume passes cursor resumeArgs", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid: 43,
        route: "cursor",
        raw: JSON.stringify({ route: "cursor" }),
      }),
    );
    await store.append(
      ev({
        id: "r",
        kind: "rpc",
        dir: "a2c",
        bridgePid: 43,
        sessionHints: ["sess-cursor-1"],
      }),
    );
    const opened: Array<[string, string, string | null, string[] | undefined, string | undefined]> = [];
    const app = acpAppWithOpenTerminal(store, (bin, sessionId, cwd, resumeArgs, resumeMode) => {
      opened.push([bin, sessionId, cwd, resumeArgs, resumeMode]);
    });
    const res = await app.request("http://127.0.0.1/api/acp-conversations/43/resume", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(opened).toEqual([
      ["/bin/echo", "sess-cursor-1", null, ["--resume", "{sessionId}"], "cursor-acp-load"],
    ]);
  });

  test("POST resume 409s when conversation has no session id", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid: 42,
        route: "opencode",
        raw: JSON.stringify({ route: "opencode" }),
      }),
    );
    await store.append(ev({ id: "e", kind: "process_end", bridgePid: 42 }));
    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-conversations/42/resume", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no session id");
  });

  test("POST resume 409s when the conversation route is not configured", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid: 42,
        route: "gone",
        raw: JSON.stringify({ route: "gone" }),
      }),
    );
    await store.append(
      ev({
        id: "r",
        kind: "rpc",
        dir: "a2c",
        bridgePid: 42,
        sessionHints: ["sess-resume-1"],
      }),
    );
    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-conversations/42/resume", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no route for this conversation");
  });

  test("POST resume 404s when conversation is missing", async () => {
    const store = new AcpEventStore(eventsPath);
    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-conversations/999/resume", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("PUT /api/acp-conversations/:pid/model 400s on bad body", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid: 42,
        route: "opencode",
        raw: JSON.stringify({ route: "opencode" }),
      }),
    );
    const app = acpApp(store);
    const missing = await app.request("http://127.0.0.1/api/acp-conversations/42/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    const empty = await app.request("http://127.0.0.1/api/acp-conversations/42/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "" }),
    });
    expect(empty.status).toBe(400);
    const notString = await app.request("http://127.0.0.1/api/acp-conversations/42/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: 42 }),
    });
    expect(notString.status).toBe(400);
  });

  test("GET /api/acp-conversation-sessions groups by acpSessionId", async () => {
    const store = new AcpEventStore(eventsPath);
    const livePid = process.pid;
    await store.append(
      ev({
        id: "a1",
        kind: "process_start",
        bridgePid: 100,
        route: "cursor",
        raw: JSON.stringify({ route: "cursor" }),
        ts: "2026-08-21T14:00:00.000Z",
      }),
    );
    await store.append(
      ev({
        id: "a2",
        kind: "rpc",
        bridgePid: 100,
        method: "session/new",
        dir: "a2c",
        sessionHints: ["sess-shared"],
        ts: "2026-08-21T14:00:01.000Z",
      }),
    );
    await store.append(
      ev({
        id: "b1",
        kind: "process_start",
        bridgePid: livePid,
        route: "cursor",
        raw: JSON.stringify({ route: "cursor" }),
        ts: "2026-08-22T14:00:00.000Z",
      }),
    );
    await store.append(
      ev({
        id: "b2",
        kind: "rpc",
        bridgePid: livePid,
        method: "session/load",
        dir: "c2a",
        sessionHints: ["sess-shared"],
        ts: "2026-08-22T14:00:01.000Z",
      }),
    );
    const app = acpApp(store);
    const res = await app.request("http://127.0.0.1/api/acp-conversation-sessions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const sessionGroups = body.filter((g: { kind: string }) => g.kind === "session");
    expect(sessionGroups).toHaveLength(1);
    expect(sessionGroups[0].acpSessionId).toBe("sess-shared");
    expect(sessionGroups[0].spawns).toHaveLength(2);
    expect(sessionGroups[0].representativeBridgePid).toBe(livePid);
    expect(sessionGroups[0].representative).toBeUndefined();
  });
});
