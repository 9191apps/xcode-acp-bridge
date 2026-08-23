import fs from "node:fs/promises";
import path from "node:path";
import type { AcpEventStore } from "./event-store";
import type { AcpEvent } from "./types";

/**
 * Follows externally-written conversation files (the ACP bridge appends from a
 * separate process). Byte-offset incremental: each poll only parses the bytes
 * appended since the last poll — never a full-file reload.
 *
 * The first pass only records current sizes, so pre-existing history is not
 * re-emitted (the store already loaded it in `load()`).
 */
export type AcpTailTrack = Map<string, { size: number; rest: string }>;

export async function tickAcpTail(
  store: AcpEventStore,
  onEvent: (e: AcpEvent) => void,
  tracking: AcpTailTrack,
  initial = false,
): Promise<void> {
  let names: string[];
  try {
    names = (await fs.readdir(store.dir)).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    return;
  }

  // Drop tracking for files that disappeared (e.g. retention or clear).
  for (const name of [...tracking.keys()]) {
    if (!names.includes(name)) tracking.delete(name);
  }

  const decoder = new TextDecoder();
  for (const name of names) {
    const filePath = path.join(store.dir, name);
    let size: number;
    try {
      size = (await fs.stat(filePath)).size;
    } catch {
      continue;
    }
    const t = tracking.get(name) ?? { size: 0, rest: "" };
    if (size < t.size) {
      // File was truncated/rotated: restart from the top.
      t.size = 0;
      t.rest = "";
    }
    if (size <= t.size) {
      tracking.set(name, t);
      continue;
    }
    const length = size - t.size;
    const fh = await fs.open(filePath, "r");
    let buf: Uint8Array;
    try {
      buf = new Uint8Array(length);
      await fh.read(buf, 0, length, t.size);
    } finally {
      await fh.close();
    }
    const text = t.rest + decoder.decode(buf);
    const lines = text.split("\n");
    t.rest = lines.pop() ?? "";
    t.size = size;
    tracking.set(name, t);

    if (initial) continue; // first pass: sizes only, no events
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: AcpEvent;
      try {
        event = JSON.parse(trimmed) as AcpEvent;
      } catch {
        continue; // partial/corrupt line
      }
      store.ingest(event);
      onEvent(event);
    }
  }
}

export function startAcpTail(
  store: AcpEventStore,
  onEvent: (e: AcpEvent) => void,
): () => void {
  const tracking: AcpTailTrack = new Map();
  let inFlight = false;
  let initialized = false;

  async function poll(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      if (!initialized) {
        await tickAcpTail(store, onEvent, tracking, true);
        initialized = true;
      } else {
        await tickAcpTail(store, onEvent, tracking, false);
      }
    } finally {
      inFlight = false;
    }
  }

  void poll();
  const timer = setInterval(() => void poll(), 250);
  return () => clearInterval(timer);
}
