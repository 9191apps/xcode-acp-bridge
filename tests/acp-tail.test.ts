import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { AcpEventStore } from "../src/acp/event-store";
import { tickAcpTail, type AcpTailTrack } from "../src/acp/tail";
import type { AcpEvent } from "../src/acp/types";

const dir = path.join(import.meta.dir, ".tmp-acp-tail");
const eventsPath = path.join(dir, "acp-events.jsonl");

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

describe("acp tail", () => {
  test("initial pass records sizes without emitting; appends emit once", async () => {
    const store = new AcpEventStore(eventsPath);
    await store.append(ev({ id: "seed", kind: "process_start" }));
    const tracking: AcpTailTrack = new Map();
    const seen: string[] = [];

    // First pass: existing history is not re-emitted.
    await tickAcpTail(store, (e) => seen.push(e.id), tracking, true);
    expect(seen).toEqual([]);

    // External append (no process_start needed — file already tracked).
    await fs.appendFile(path.join(store.dir, "1-x.jsonl"), `${JSON.stringify(ev({ id: "new-1" }))}\n`, "utf8");
    await tickAcpTail(store, (e) => seen.push(e.id), tracking, false);
    expect(seen).toEqual(["new-1"]);
    expect(store.getById("new-1")).not.toBeNull();
  });

  test("partial line (no trailing newline) is buffered until complete", async () => {
    const store = new AcpEventStore(eventsPath);
    const tracking: AcpTailTrack = new Map();
    const seen: string[] = [];
    const fileName = "1-x.jsonl";
    const filePath = path.join(store.dir, fileName);
    await fs.mkdir(store.dir, { recursive: true });

    // Half a line, no newline.
    const partial = JSON.stringify(ev({ id: "partial-1" })).slice(0, -5);
    await fs.appendFile(filePath, partial, "utf8");
    await tickAcpTail(store, (e) => seen.push(e.id), tracking, false);
    expect(seen).toEqual([]);

    // Rest of the line + newline.
    await fs.appendFile(filePath, `${JSON.stringify(ev({ id: "partial-1" })).slice(-5)}\n`, "utf8");
    await tickAcpTail(store, (e) => seen.push(e.id), tracking, false);
    expect(seen).toEqual(["partial-1"]);
  });

  test("truncated file restarts from the top", async () => {
    const store = new AcpEventStore(eventsPath);
    const tracking: AcpTailTrack = new Map();
    const seen: string[] = [];
    const filePath = path.join(store.dir, "1-x.jsonl");
    await fs.mkdir(store.dir, { recursive: true });

    await fs.appendFile(filePath, `${JSON.stringify(ev({ id: "a1" }))}\n`, "utf8");
    await tickAcpTail(store, (e) => seen.push(e.id), tracking, false);
    expect(seen).toEqual(["a1"]);

    // File truncated (e.g. clear by another process) and rewritten with a
    // shorter line, so the new size is smaller than the tracked size.
    await fs.writeFile(filePath, `${JSON.stringify(ev({ id: "b" }))}\n`, "utf8");
    await tickAcpTail(store, (e) => seen.push(e.id), tracking, false);
    expect(seen).toEqual(["a1", "b"]);
  });

  test("new files appearing after the initial pass are picked up", async () => {
    const store = new AcpEventStore(eventsPath);
    const tracking: AcpTailTrack = new Map();
    const seen: string[] = [];
    await tickAcpTail(store, (e) => seen.push(e.id), tracking, true);

    await fs.mkdir(store.dir, { recursive: true });
    await fs.appendFile(path.join(store.dir, "1-new.jsonl"), `${JSON.stringify(ev({ id: "late" }))}\n`, "utf8");
    await tickAcpTail(store, (e) => seen.push(e.id), tracking, false);
    expect(seen).toEqual(["late"]);
  });
});
