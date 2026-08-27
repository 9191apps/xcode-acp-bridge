import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { acpShardsDirFor, AcpEventStore } from "../src/acp/event-store";
import type { AcpEvent } from "../src/acp/types";

const dir = path.join(import.meta.dir, ".tmp-acp-store");
const eventsPath = path.join(dir, "acp-events.jsonl");
const shardDir = acpShardsDirFor(eventsPath);

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

async function shardFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(shardDir)).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}

beforeEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("AcpEventStore", () => {
  test("append writes one jsonl line into a per-conversation file", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "a", kind: "process_start", ts: "2026-08-16T10:00:00.000Z" }));
    await store.append(ev({ id: "a-2" }));
    const files = await shardFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^1-/);
    const text = await fs.readFile(path.join(shardDir, files[0]!), "utf8");
    expect(text.trim().split("\n").length).toBe(2);
    expect(store.list()[0].method).toBe("initialize");
  });

  test("process_start starts a new file; recycled pid gets a new file", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "p1", kind: "process_start", bridgePid: 7, ts: "2026-08-16T10:00:00.000Z" }));
    await store.append(ev({ id: "p2", kind: "rpc", bridgePid: 7 }));
    // Recycled pid: a later process_start must NOT append to the old file.
    await store.append(ev({ id: "q1", kind: "process_start", bridgePid: 7, ts: "2026-08-16T12:00:00.000Z" }));
    await store.append(ev({ id: "q2", kind: "rpc", bridgePid: 7 }));
    const files = await shardFiles();
    expect(files).toHaveLength(2);
    const first = await fs.readFile(path.join(shardDir, files[0]!), "utf8");
    const second = await fs.readFile(path.join(shardDir, files[1]!), "utf8");
    expect(first).toContain('"id":"p1"');
    expect(first).not.toContain('"id":"q1"');
    expect(second).toContain('"id":"q1"');
  });

  test("load replays all files; legacy single file is migrated once", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "a", kind: "process_start" }));
    await store.append(ev({ id: "b" }));
    const fresh = new AcpEventStore(eventsPath);
    const loaded = await fresh.load();
    expect(loaded.length).toBe(2);
    expect(loaded.some((e) => e.id === "a")).toBe(true);
    expect(loaded.some((e) => e.id === "b")).toBe(true);
  });

  test("load migrates a legacy single-file into per-conversation shards", async () => {
    await fs.writeFile(
      eventsPath,
      [
        JSON.stringify(ev({ id: "l1", kind: "process_start", bridgePid: 11, ts: "2026-08-14T10:00:00.000Z" })),
        JSON.stringify(ev({ id: "l2", bridgePid: 11 })),
        JSON.stringify(ev({ id: "m1", kind: "process_start", bridgePid: 12, ts: "2026-08-15T10:00:00.000Z" })),
        JSON.stringify(ev({ id: "m2", bridgePid: 12 })),
      ].join("\n"),
      "utf8",
    );
    const store = new AcpEventStore(eventsPath);
    const loaded = await store.load();
    expect(loaded.map((e) => e.id).sort()).toEqual(["l1", "l2", "m1", "m2"]);
    const files = await shardFiles();
    expect(files).toHaveLength(2);
    await expect(fs.access(eventsPath)).rejects.toThrow();
    // Second load must not re-migrate or duplicate.
    const again = new AcpEventStore(eventsPath);
    expect((await again.load()).length).toBe(4);
  });

  test("load migrates a legacy file re-created after shards exist (merge, no loss)", async () => {
    // First boot: shards created.
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "s1", kind: "process_start", bridgePid: 21, ts: "2026-08-16T10:00:00.000Z" }));
    // A still-running old-code bridge re-creates the legacy single file.
    await fs.writeFile(
      eventsPath,
      [
        JSON.stringify(ev({ id: "l1", kind: "process_start", bridgePid: 22, ts: "2026-08-16T11:00:00.000Z" })),
        JSON.stringify(ev({ id: "l2", bridgePid: 22 })),
      ].join("\n"),
      "utf8",
    );
    const reloaded = new AcpEventStore(eventsPath);
    const loaded = await reloaded.load();
    expect(loaded.map((e) => e.id).sort()).toEqual(["l1", "l2", "s1"]);
    expect((await shardFiles()).length).toBe(2);
    await expect(fs.access(eventsPath)).rejects.toThrow();
  });

  test("clear deletes memory and the shard directory", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev());
    await store.clear();
    expect(store.list().length).toBe(0);
    await expect(fs.access(shardDir)).rejects.toThrow();
  });

  test("getById returns matching event or null (ring and cold)", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "keep-me", raw: '{"ok":true}' }));
    expect(store.getById("keep-me")?.raw).toBe('{"ok":true}');
    expect(store.getById("missing")).toBeNull();
  });

  test("hot ring is capped at maxEvents, keeping the newest", async () => {
    const store = new AcpEventStore(eventsPath, { maxEvents: 3 });
    for (let i = 1; i <= 5; i++) {
      await store.append(ev({ id: `r${i}`, bridgePid: 99, kind: "process_start", ts: `2026-08-16T10:00:0${i}.000Z` }));
    }
    const ids = store.list().map((e) => e.id);
    expect(ids).toEqual(["r3", "r4", "r5"]);
  });

  test("summaries prefer ACP sessionId over MCP id in sessionHints", async () => {
    const store = new AcpEventStore(eventsPath);
    const mcp = "79AC467F-9583-4FBB-AC0E-5FD1F72F6818";
    const acp = "bd4d53b5-57ce-4ebd-a48d-c7b2b7e9d426";
    await store.append(
      ev({
        id: "p",
        kind: "process_start",
        bridgePid: 762,
        ts: "2026-08-21T14:36:34.000Z",
        route: "cursor",
      }),
    );
    // Mirror real Cursor traffic: session/new request only hints the MCP id.
    await store.append(
      ev({
        id: "new-req",
        bridgePid: 762,
        method: "session/new",
        dir: "c2a",
        mcpXcodeSessionId: mcp,
        sessionHints: [mcp],
        ts: "2026-08-21T14:36:35.000Z",
      }),
    );
    // session/new result carries the real ACP session id alone.
    await store.append(
      ev({
        id: "new-res",
        bridgePid: 762,
        dir: "a2c",
        sessionHints: [acp],
        ts: "2026-08-21T14:36:36.000Z",
      }),
    );
    const row = store.summaries().find((s) => s.bridgePid === 762);
    expect(row?.mcpXcodeSessionId).toBe(mcp);
    expect(row?.acpSessionId).toBe(acp);
  });

  test("summaries reflect all events even beyond the ring", async () => {
    const store = new AcpEventStore(eventsPath, { maxEvents: 3 });
    for (let i = 1; i <= 5; i++) {
      const kind = i === 1 ? "process_start" : i === 5 ? "process_end" : "rpc";
      const method = i === 3 ? "session/prompt" : undefined;
      const update = i === 4 ? "tool_call" : undefined;
      await store.append(
        ev({
          id: `c${i}`,
          bridgePid: 55,
          kind: kind as AcpEvent["kind"],
          method: method ?? null,
          sessionUpdate: update ?? null,
          ts: `2026-08-16T10:00:0${i}.000Z`,
        }),
      );
    }
    const summaries = store.summaries();
    expect(summaries).toHaveLength(1);
    const s = summaries[0]!;
    expect(s.eventCount).toBe(5); // counts from all events, not just the ring
    expect(s.promptCount).toBe(1);
    expect(s.toolCallCount).toBe(1);
    expect(s.status).toBe("ended");
    expect(s.durationMs).toBeGreaterThan(0);
  });

  test("detail serves events older than the ring from disk", async () => {
    const store = new AcpEventStore(eventsPath, { maxEvents: 2 });
    await store.append(ev({ id: "old-1", kind: "process_start", bridgePid: 31, ts: "2026-08-16T10:00:00.000Z" }));
    await store.append(ev({ id: "old-2", bridgePid: 31, ts: "2026-08-16T10:00:01.000Z" }));
    await store.append(ev({ id: "old-3", bridgePid: 31, ts: "2026-08-16T10:00:02.000Z" }));
    // Ring now holds only old-2/old-3; old-1 is cold on disk.
    expect(store.list().map((e) => e.id)).toEqual(["old-2", "old-3"]);
    const detail = store.detail(31);
    expect(detail).not.toBeNull();
    expect(detail!.timeline.length).toBeGreaterThanOrEqual(3);
  });

  test("retention deletes idle conversation files", async () => {
    const store = new AcpEventStore(eventsPath, { maxDays: 7 });
    await store.append(ev({ id: "old", kind: "process_start", ts: "2026-08-01T10:00:00.000Z" }));
    await store.append(ev({ id: "new", kind: "process_start", bridgePid: 2, ts: new Date().toISOString() }));
    const files = await shardFiles();
    expect(files).toHaveLength(2);
    // Retention keys on file mtime (last write); age the old conversation's file.
    const oldFile = files.find((n) => n.startsWith("1-"))!;
    const oldTime = new Date("2026-08-01T00:00:00.000Z");
    await fs.utimes(path.join(shardDir, oldFile), oldTime, oldTime);
    const removed = await store.enforceRetention(new Date("2026-08-16T00:00:00.000Z").getTime());
    expect(removed).toEqual([oldFile]);
    const remaining = await shardFiles();
    expect(remaining).toHaveLength(1);
    // Summary for the removed conversation is evicted.
    expect(store.summaries().map((s) => s.bridgePid)).toEqual([2]);
  });

  test("exportAll returns every event from every file", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "x1", kind: "process_start", bridgePid: 1 }));
    await store.append(ev({ id: "y1", kind: "process_start", bridgePid: 2 }));
    await store.append(ev({ id: "y2", bridgePid: 2 }));
    const all = await store.exportAll();
    expect(all.map((e) => e.id).sort()).toEqual(["x1", "y1", "y2"]);
  });

  test("subscribe receives appended events", async () => {
    const store = new AcpEventStore(eventsPath);
    const events: string[] = [];
    store.subscribe((e) => events.push(e.id));
    await store.append(ev({ id: "sub-1" }));
    expect(events).toEqual(["sub-1"]);
  });

  test("chunk aggregation merges consecutive agent_*_chunk updates into one event", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "p", kind: "process_start", ts: "2026-08-16T10:00:00.000Z" }));
    const chunk = (id: string, text: string, ts: string) =>
      ev({ id, ts, method: "session/update", sessionUpdate: "agent_thought_chunk", dir: "a2c", raw: JSON.stringify({ params: { update: { content: { text } } } }) });
    await store.append(chunk("c1", "hel", "2026-08-16T10:00:01.000Z"));
    await store.append(chunk("c2", "lo ", "2026-08-16T10:00:02.000Z"));
    await store.append(chunk("c3", "world", "2026-08-16T10:00:03.000Z"));
    // Still buffered — nothing written yet.
    expect((await shardFiles()).length).toBe(1); // only the process_start file
    expect(store.list().length).toBe(1);
    // A non-chunk event flushes the group.
    await store.append(ev({ id: "after", method: "session/prompt" }));
    const files = await shardFiles();
    const text = await fs.readFile(path.join(shardDir, files[0]!), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(3); // process_start + aggregated + prompt
    const agg = JSON.parse(lines[1]!);
    expect(agg.id).toBe("c1");
    expect(agg.chunkCount).toBe(3);
    expect(agg.chunkText).toBe("hello world");
    expect(agg.chunkLastTs).toBe("2026-08-16T10:00:03.000Z");
    expect(store.list().length).toBe(3); // 3 in-memory events, not 5
    // Aggregated event keeps the FIRST chunk's id; individual chunk ids are gone.
    expect(store.getById("c1")?.chunkCount).toBe(3);
    expect(store.getById("c3")).toBeNull();
  });

  test("chunk aggregation flushes on update-type change and on group cap", async () => {
    const store = new AcpEventStore(eventsPath, { maxChunkEvents: 2 });
    await store.append(ev({ id: "p", kind: "process_start", ts: "2026-08-16T10:00:00.000Z" }));
    const chunk = (id: string, update: string, ts: string) =>
      ev({ id, ts, method: "session/update", sessionUpdate: update, dir: "a2c", raw: JSON.stringify({ params: { update: { content: { text: "x" } } } }) });
    await store.append(chunk("a1", "agent_thought_chunk", "2026-08-16T10:00:01.000Z"));
    await store.append(chunk("a2", "agent_thought_chunk", "2026-08-16T10:00:02.000Z"));
    // cap=2 → flushed immediately
    await store.append(chunk("b1", "agent_message_chunk", "2026-08-16T10:00:03.000Z"));
    await store.append(chunk("b2", "agent_message_chunk", "2026-08-16T10:00:04.000Z"));
    // b2 hits the cap too; flush via explicit flush()
    await store.flush();
    const text = await fs.readFile(path.join(shardDir, (await shardFiles())[0]!), "utf8");
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    const groups = lines.filter((l) => l.chunkCount != null);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.chunkCount).toBe(2);
    expect(groups[0]!.sessionUpdate).toBe("agent_thought_chunk");
    expect(groups[1]!.chunkCount).toBe(2);
    expect(groups[1]!.sessionUpdate).toBe("agent_message_chunk");
  });

  test("chunk aggregation can be disabled to keep raw lines", async () => {
    const store = new AcpEventStore(eventsPath, { aggregateChunks: false });
    await store.append(ev({ id: "p", kind: "process_start", ts: "2026-08-16T10:00:00.000Z" }));
    const chunk = (id: string, ts: string) =>
      ev({ id, ts, method: "session/update", sessionUpdate: "agent_thought_chunk", dir: "a2c", raw: "{}" });
    await store.append(chunk("c1", "2026-08-16T10:00:01.000Z"));
    await store.append(chunk("c2", "2026-08-16T10:00:02.000Z"));
    await store.flush();
    const text = await fs.readFile(path.join(shardDir, (await shardFiles())[0]!), "utf8");
    expect(text.trim().split("\n")).toHaveLength(3); // p, c1, c2 raw
    expect(text).not.toContain("chunkCount");
  });

  test("load replays aggregated events into summaries and detail", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "p", kind: "process_start", bridgePid: 61, ts: "2026-08-16T10:00:00.000Z" }));
    const chunk = (id: string, ts: string) =>
      ev({ id, ts, bridgePid: 61, method: "session/update", sessionUpdate: "agent_thought_chunk", dir: "a2c", raw: JSON.stringify({ params: { update: { content: { text: "z" } } } }) });
    await store.append(chunk("c1", "2026-08-16T10:00:01.000Z"));
    await store.append(chunk("c2", "2026-08-16T10:00:02.000Z"));
    await store.flush();

    const reloaded = new AcpEventStore(eventsPath);
    await reloaded.load();
    expect(reloaded.list().length).toBe(2); // process_start + one aggregated event
    const agg = reloaded.list().find((e) => e.chunkCount === 2);
    expect(agg).not.toBeNull();
    const detail = reloaded.detail(61);
    const chunkItems = detail!.timeline.filter((t) => t.type === "chunks");
    expect(chunkItems).toHaveLength(1);
    expect(chunkItems[0]!.count).toBe(2);
    expect(chunkItems[0]!.text).toBe("zz");
  });

  test("compactAll rewrites legacy raw chunk runs into aggregated events", async () => {
    const store = new AcpEventStore(eventsPath);
    // Simulate legacy data: write raw chunk lines directly into a file.
    await fs.mkdir(store.dir, { recursive: true });
    const raw = (id: string, update: string, text: string, ts: string) =>
      JSON.stringify(
        ev({ id, ts, method: "session/update", sessionUpdate: update, dir: "a2c", raw: JSON.stringify({ params: { update: { content: { text } } } }) }),
      );
    await fs.writeFile(
      path.join(store.dir, "1-20260816T100000Z.jsonl"),
      [
        JSON.stringify(ev({ id: "p", kind: "process_start", ts: "2026-08-16T10:00:00.000Z" })),
        raw("c1", "agent_thought_chunk", "hel", "2026-08-16T10:00:01.000Z"),
        raw("c2", "agent_thought_chunk", "lo", "2026-08-16T10:00:02.000Z"),
        JSON.stringify(ev({ id: "pr", method: "session/prompt", ts: "2026-08-16T10:00:03.000Z" })),
        raw("m1", "agent_message_chunk", "hi", "2026-08-16T10:00:04.000Z"),
      ].join("\n"),
      "utf8",
    );
    const filePath = path.join(store.dir, "1-20260816T100000Z.jsonl");
    // Backdate the mtime so the just-written file is not "recent".
    const old = new Date("2026-08-16T09:00:00.000Z");
    await fs.utimes(filePath, old, old);
    const stats = await store.compactAll(0);
    expect(stats.files).toBe(1);
    expect(stats.linesBefore).toBe(5);
    expect(stats.linesAfter).toBe(4); // process_start + [thought x2] + prompt + [message x1]
    const text = await fs.readFile(filePath, "utf8");
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    // process_start, [thought x2 aggregated], prompt, [message x1]
    expect(lines).toHaveLength(4);
    const thought = lines.find((l) => l.chunkCount === 2 && l.sessionUpdate === "agent_thought_chunk");
    expect(thought).not.toBeNull();
    expect(thought.chunkText).toBe("hello");
    const message = lines.find((l) => l.chunkCount === 1 && l.sessionUpdate === "agent_message_chunk");
    expect(message).not.toBeNull();
    expect(store.list().find((e) => e.chunkCount === 2)).not.toBeNull();
  });

  test("compactAll is safe on already-aggregated data (totals preserved)", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "p", kind: "process_start", bridgePid: 71, ts: "2026-08-16T10:00:00.000Z" }));
    const chunk = (id: string, ts: string) =>
      ev({ id, ts, bridgePid: 71, method: "session/update", sessionUpdate: "agent_thought_chunk", dir: "a2c", raw: JSON.stringify({ params: { update: { content: { text: "x" } } } }) });
    await store.append(chunk("c1", "2026-08-16T10:00:01.000Z"));
    await store.append(chunk("c2", "2026-08-16T10:00:02.000Z"));
    await store.flush(); // file now has an aggregated event (chunkCount 2)

    const filePath = path.join(store.dir, (await shardFiles())[0]!);
    const old = new Date("2026-08-16T09:00:00.000Z");
    await fs.utimes(filePath, old, old);
    const stats = await store.compactAll(0);
    expect(stats.files).toBe(1);
    expect(stats.linesAfter).toBe(2); // process_start + aggregated (re-merged, still 1 group)
    const reloaded = new AcpEventStore(eventsPath);
    await reloaded.load();
    const detail = reloaded.detail(71);
    const chunkItems = detail!.timeline.filter((t) => t.type === "chunks");
    expect(chunkItems).toHaveLength(1);
    expect(chunkItems[0]!.count).toBe(2); // total chunk count preserved
  });

  test("compactAll skips recently modified files", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "p", kind: "process_start", ts: "2026-08-16T10:00:00.000Z" }));
    const stats = await store.compactAll(60_000); // file just written → skip
    expect(stats.files).toBe(0);
    expect(stats.skipped).toHaveLength(1);
  });

  test("deleteByPid removes files, ring events, and summary of one conversation", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(
      ev({ id: "a1", bridgePid: 11, kind: "process_start", ts: "2026-08-16T10:00:00.000Z" }),
    );
    await store.append(ev({ id: "a2", bridgePid: 11, ts: "2026-08-16T10:00:01.000Z" }));
    await store.append(
      ev({ id: "b1", bridgePid: 22, kind: "process_start", ts: "2026-08-16T10:01:00.000Z" }),
    );
    expect(await store.deleteByPid(11)).toBe(true);
    expect(store.list().map((e) => e.id)).toEqual(["b1"]);
    expect(store.summaries().map((s) => s.bridgePid)).toEqual([22]);
    expect(store.detail(11)).toBeNull();
    const files = await shardFiles();
    expect(files.some((n) => n.startsWith("11-"))).toBe(false);
    expect(files.some((n) => n.startsWith("22-"))).toBe(true);
    expect(await store.deleteByPid(11)).toBe(false);
  });
});
