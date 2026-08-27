import fs from "node:fs/promises";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { CHUNK_UPDATES, chunkTextFromRaw, conversationDetail } from "./conversations";
import type { ConversationDetail, ConversationSummary } from "./conversations";
import type { AcpEvent } from "./types";

/**
 * ACP event storage — one JSONL file per conversation.
 *
 * Layout (derived from `eventsPath` by stripping its extension):
 *
 *   data/acp-events/
 *     38291-20260814T153831Z.jsonl   ← one Xcode spawn / bridgePid
 *     40810-20260814T153913Z.jsonl
 *
 * Why per-conversation: measured usage is *few conversations with huge event
 * counts* (12 conversations / 357k events / 241 MB), dominated by `session/
 * update` chunks. A per-conversation file makes retention, cold detail reads
 * and export trivial, and keeps memory bounded via a hot ring + summary cache.
 *
 * Memory model:
 *  - hot ring: newest `maxEvents` events (default 20_000) — live views.
 *  - summary cache: one `ConversationSummary` per pid, maintained O(1) per
 *    event (seeded by a streaming scan at load()).
 *  - cold cache: events read back from disk for ended/older conversations,
 *    bounded by `maxColdBytes` (default 200 MB), LRU.
 *
 * The legacy single-file `acp-events.jsonl` is auto-migrated into the shard
 * dir on first load() (streaming, resilient, then the legacy file is removed).
 */
export type AcpStoreOptions = {
  /** Hot ring size. Default: env MAX_ACP_EVENTS ?? 20000. */
  maxEvents?: number;
  /** Retention: delete conversation files idle for this many days. Default: env MAX_ACP_DAYS ?? 30. */
  maxDays?: number;
  /** Cold cache byte budget. Default: env MAX_ACP_COLD_MB ?? 200. */
  maxColdBytes?: number;
  /** Aggregate consecutive agent_*_chunk updates into one stored event. Default: env MAX_ACP_CHUNK_AGGREGATE != "0". */
  aggregateChunks?: boolean;
  /** Max raw chunks per aggregated group. Default: env MAX_ACP_CHUNK_EVENTS ?? 2000. */
  maxChunkEvents?: number;
  /** Max raw bytes per aggregated group. Default: env MAX_ACP_CHUNK_BYTES ?? 512 * 1024. */
  maxChunkBytes?: number;
};

export function acpShardsDirFor(eventsPath: string): string {
  const parsed = path.parse(eventsPath);
  return path.join(parsed.dir, parsed.name);
}

function sanitizeTs(ts: string): string {
  return ts.replace(/[^A-Za-z0-9._-]/g, "-");
}

function pidFromFileName(name: string): number | null {
  const dash = name.indexOf("-");
  if (dash <= 0) return null;
  const n = Number(name.slice(0, dash));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function pidFromEventId(id: string): number | null {
  const dash = id.lastIndexOf("-");
  if (dash <= 0) return null;
  const n = Number(id.slice(0, dash));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function msBetween(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

/**
 * Rewrite a list of events with chunk aggregation applied (no size caps — a
 * bounded file is already in memory). Already-aggregated events contribute
 * their chunkCount/chunkText; raw chunk events contribute one piece each.
 */
function aggregateChunkLines(events: AcpEvent[]): AcpEvent[] {
  const out: AcpEvent[] = [];
  let g: {
    update: string;
    firstId: string;
    firstTs: string;
    count: number;
    text: string;
    last: AcpEvent;
    lastTs: string;
  } | null = null;
  const flush = () => {
    if (!g) return;
    const aggregated: AcpEvent = {
      ...g.last,
      id: g.firstId,
      ts: g.firstTs,
      chunkCount: g.count,
      chunkText: g.text,
      chunkLastTs: g.lastTs,
      raw: g.last.raw,
    };
    out.push(aggregated);
    g = null;
  };

  for (const event of events) {
    const update = event.sessionUpdate;
    if (update != null && CHUNK_UPDATES.has(update)) {
      const count = event.chunkCount ?? 1;
      const piece = event.chunkText ?? chunkTextFromRaw(event.raw);
      if (g && g.update === update) {
        g.count += count;
        g.text += piece;
        g.last = event;
        g.lastTs = event.chunkLastTs ?? event.ts;
      } else {
        flush();
        g = {
          update,
          firstId: event.id,
          firstTs: event.ts,
          count,
          text: piece,
          last: event,
          lastTs: event.chunkLastTs ?? event.ts,
        };
      }
      continue;
    }
    flush();
    out.push(event);
  }
  flush();
  return out;
}

type SummaryState = {
  bridgePid: number;
  backendPid: number | null;
  route: string | null;
  cwd: string | null;
  mcpXcodeSessionId: string | null;
  hint1: string | null;
  hint2: string | null;
  startedAt: string | null;
  processStartTs: string | null;
  endedAt: string | null;
  lastActivityAt: string | null;
  hasProcessEnd: boolean;
  hasProcessStartError: boolean;
  promptCount: number;
  toolCallCount: number;
  eventCount: number;
  model: string | null;
};

/** Buffered run of consecutive agent_*_chunk updates awaiting aggregation. */
type PendingChunk = {
  bridgePid: number;
  update: string;
  first: AcpEvent;
  last: AcpEvent;
  count: number;
  text: string;
  bytes: number;
};

export class AcpEventStore {
  private ring: AcpEvent[] = [];
  private summaryState = new Map<number, SummaryState>();
  private filesByPid = new Map<number, Set<string>>();
  private activeFileByPid = new Map<number, string>();
  private coldCache = new Map<string, { events: AcpEvent[]; bytes: number; at: number }>();
  private coldBytes = 0;
  private coldClock = 0;
  private listeners: Array<(event: AcpEvent) => void> = [];
  private pendingChunk: PendingChunk | null = null;
  readonly dir: string;

  constructor(
    readonly eventsPath: string,
    private readonly opts: AcpStoreOptions = {},
  ) {
    this.dir = acpShardsDirFor(eventsPath);
  }

  get maxEvents(): number {
    return this.opts.maxEvents ?? Number(process.env.MAX_ACP_EVENTS ?? 20000);
  }

  get maxDays(): number {
    return this.opts.maxDays ?? Number(process.env.MAX_ACP_DAYS ?? 30);
  }

  get maxColdBytes(): number {
    return (this.opts.maxColdBytes ?? Number(process.env.MAX_ACP_COLD_MB ?? 200)) * 1024 * 1024;
  }

  get aggregateChunks(): boolean {
    if (this.opts.aggregateChunks != null) return this.opts.aggregateChunks;
    return (process.env.MAX_ACP_CHUNK_AGGREGATE ?? "1") !== "0";
  }

  get maxChunkEvents(): number {
    return this.opts.maxChunkEvents ?? Number(process.env.MAX_ACP_CHUNK_EVENTS ?? 2000);
  }

  get maxChunkBytes(): number {
    return this.opts.maxChunkBytes ?? Number(process.env.MAX_ACP_CHUNK_BYTES ?? 512 * 1024);
  }

  /* ---- write path ------------------------------------------- */

  /** File name this event belongs to, creating the per-conversation file on process_start. */
  private fileNameFor(event: AcpEvent): string {
    const existing = this.activeFileByPid.get(event.bridgePid);
    if (existing && event.kind !== "process_start") return existing;
    const ts = event.ts || new Date().toISOString();
    const name = `${event.bridgePid}-${sanitizeTs(ts)}.jsonl`;
    this.activeFileByPid.set(event.bridgePid, name);
    let files = this.filesByPid.get(event.bridgePid);
    if (!files) {
      files = new Set();
      this.filesByPid.set(event.bridgePid, files);
    }
    files.add(name);
    return name;
  }

  async append(event: AcpEvent): Promise<void> {
    // Chunk aggregation: buffer consecutive agent_*_chunk updates and write
    // them as ONE event, so a 100k-chunk thought stream becomes ~200 file
    // lines instead of 100k. The group is flushed on the next non-chunk event,
    // on a type/pid change, or when the group hits its size caps.
    const update = event.sessionUpdate;
    if (this.aggregateChunks && update != null && CHUNK_UPDATES.has(update)) {
      const g = this.pendingChunk;
      const piece = chunkTextFromRaw(event.raw);
      if (g && g.bridgePid === event.bridgePid && g.update === update) {
        g.count += 1;
        g.text += piece;
        g.bytes += event.raw.length;
        g.last = event;
      } else {
        await this.flushPending();
        this.pendingChunk = {
          bridgePid: event.bridgePid,
          update,
          first: event,
          last: event,
          count: 1,
          text: piece,
          bytes: event.raw.length,
        };
      }
      const group = this.pendingChunk;
      if (
        group != null &&
        (group.count >= this.maxChunkEvents || group.bytes >= this.maxChunkBytes)
      ) {
        await this.flushPending();
      }
      return;
    }

    await this.flushPending();
    const name = this.fileNameFor(event);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(path.join(this.dir, name), `${JSON.stringify(event)}\n`, "utf8");
    this.absorb(event, true);
  }

  /** Write the buffered chunk group as a single aggregated event, if any. */
  async flushPending(): Promise<void> {
    const g = this.pendingChunk;
    if (!g) return;
    this.pendingChunk = null;
    const aggregated: AcpEvent = {
      ...g.last,
      id: g.first.id,
      ts: g.first.ts,
      chunkCount: g.count,
      chunkText: g.text,
      chunkLastTs: g.last.ts,
      raw: g.last.raw,
    };
    const name = this.fileNameFor(aggregated);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(path.join(this.dir, name), `${JSON.stringify(aggregated)}\n`, "utf8");
    this.absorb(aggregated, true);
  }

  /** Flush any buffered chunk group (e.g. on graceful shutdown). */
  async flush(): Promise<void> {
    await this.flushPending();
  }

  /**
   * Ingest an externally-written event (from the tail) into memory: hot ring,
   * summary cache. Never writes to disk and does NOT emit — the tail's own
   * `onEvent` callback is the single publish path for external events
   * (otherwise the dashboard would double-publish via the store subscription).
   */
  ingest(event: AcpEvent): void {
    this.absorb(event, false);
  }

  private absorb(event: AcpEvent, emit: boolean): void {
    this.ring.push(event);
    if (this.ring.length > this.maxEvents) this.ring.splice(0, this.ring.length - this.maxEvents);

    this.updateSummary(event);
    this.extendColdForPid(event);

    if (emit) {
      for (const listener of this.listeners) listener(event);
    }
  }

  private updateSummary(event: AcpEvent): void {
    let s = this.summaryState.get(event.bridgePid);
    if (!s) {
      s = {
        bridgePid: event.bridgePid,
        backendPid: null,
        route: null,
        cwd: null,
        mcpXcodeSessionId: null,
        hint1: null,
        hint2: null,
        startedAt: null,
        processStartTs: null,
        endedAt: null,
        lastActivityAt: null,
        hasProcessEnd: false,
        hasProcessStartError: false,
        promptCount: 0,
        toolCallCount: 0,
        eventCount: 0,
        model: null,
      };
      this.summaryState.set(event.bridgePid, s);
    }

    s.eventCount++;
    s.startedAt ??= event.ts;
    if (s.backendPid == null && event.backendPid != null) s.backendPid = event.backendPid;
    if (s.cwd == null && event.cwd != null) s.cwd = event.cwd;
    if (s.mcpXcodeSessionId == null && event.mcpXcodeSessionId != null) {
      s.mcpXcodeSessionId = event.mcpXcodeSessionId;
    }
    // MCP id is also stored in sessionHints (by design). If it landed in hint1/hint2
    // before we knew mcpXcodeSessionId, drop it so a later ACP sessionId can stick.
    if (s.mcpXcodeSessionId != null) {
      if (s.hint1 === s.mcpXcodeSessionId) {
        s.hint1 = s.hint2;
        s.hint2 = null;
      }
      if (s.hint2 === s.mcpXcodeSessionId) s.hint2 = null;
    }

    // Mirror summarizeGroup(): prefer the FIRST process_start ts as the start
    // (a recycled pid may produce a second process_start later).
    if (event.kind === "process_start") {
      if (s.processStartTs == null) {
        s.processStartTs = event.ts;
        s.startedAt = event.ts;
      }
      if (event.route != null && s.route == null) s.route = event.route;
    }
    if (event.kind === "process_end") {
      s.hasProcessEnd = true;
      s.endedAt ??= event.ts;
    } else if (event.kind === "process_start_error") {
      s.hasProcessStartError = true;
      s.endedAt ??= event.ts;
    }

    // Mirror summarizeGroup(): first non-MCP sessionHint wins as acpSessionId.
    // Cursor sends MCP-only hints on session/new request, then ACP id alone on the
    // result — so we must scan every hint on every event, not only [0]/[1] of one line.
    if (event.sessionHints.length > 0) {
      const mcp = s.mcpXcodeSessionId ?? event.mcpXcodeSessionId;
      for (const h of event.sessionHints) {
        if (mcp != null && h === mcp) continue;
        if (s.hint1 == null) s.hint1 = h;
        else if (s.hint2 == null && h !== s.hint1) s.hint2 = h;
      }
    }
    if (event.method === "session/prompt") s.promptCount++;
    if (event.sessionUpdate === "tool_call") s.toolCallCount++;
    if (event.modelCurrent != null) s.model = event.modelCurrent;
    // Last activity excludes process_end (matches summarizeGroup).
    if (event.kind !== "process_end") s.lastActivityAt = event.ts;
  }

  /* ---- read paths ------------------------------------------- */

  /** Hot ring (newest events, arrival order). */
  list(): AcpEvent[] {
    return [...this.ring];
  }

  getById(id: string): AcpEvent | null {
    for (let i = this.ring.length - 1; i >= 0; i--) {
      if (this.ring[i]!.id === id) return this.ring[i]!;
    }
    const pid = pidFromEventId(id);
    const files = pid != null ? this.filesFor(pid) : this.allFiles();
    for (const name of files) {
      const found = this.coldEvents(name).find((e) => e.id === id);
      if (found) return found;
    }
    return null;
  }

  summaries(): ConversationSummary[] {
    const out: ConversationSummary[] = [];
    for (const s of this.summaryState.values()) {
      const status = s.hasProcessStartError ? "error" : s.hasProcessEnd ? "ended" : "live";
      const acpSessionId =
        s.hint1 != null && s.hint1 !== s.mcpXcodeSessionId
          ? s.hint1
          : s.hint2 != null && s.hint2 !== s.mcpXcodeSessionId
            ? s.hint2
            : null;
      out.push({
        bridgePid: s.bridgePid,
        backendPid: s.backendPid,
        route: s.route,
        cwd: s.cwd,
        mcpXcodeSessionId: s.mcpXcodeSessionId,
        acpSessionId,
        startedAt: s.startedAt ?? s.lastActivityAt ?? "",
        endedAt: s.endedAt,
        lastActivityAt: s.lastActivityAt ?? s.startedAt ?? "",
        status,
        durationMs:
          s.startedAt != null && s.lastActivityAt != null
            ? (msBetween(s.startedAt, s.lastActivityAt) ?? 0)
            : 0,
        promptCount: s.promptCount,
        toolCallCount: s.toolCallCount,
        eventCount: s.eventCount,
        model: s.model,
      });
    }
    return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }

  detail(bridgePid: number): ConversationDetail | null {
    const events = this.eventsForPid(bridgePid);
    if (events.length === 0) return null;
    return conversationDetail(events, bridgePid);
  }

  eventsForPid(bridgePid: number): AcpEvent[] {
    const ringEvents = this.ring.filter((e) => e.bridgePid === bridgePid);
    const ringIds = new Set(ringEvents.map((e) => e.id));
    const merged = [...ringEvents];
    for (const name of this.filesFor(bridgePid)) {
      for (const e of this.coldEvents(name)) {
        if (!ringIds.has(e.id)) merged.push(e);
      }
    }
    return merged;
  }

  /** All events from disk, in file order (used by export). */
  async exportAll(): Promise<AcpEvent[]> {
    const out: AcpEvent[] = [];
    for (const name of this.allFiles()) {
      out.push(...(await this.readFileEvents(name)));
    }
    return out;
  }

  /* ---- cold disk reads -------------------------------------- */

  private filesFor(bridgePid: number): string[] {
    return [...(this.filesByPid.get(bridgePid) ?? [])].sort();
  }

  private allFiles(): string[] {
    return [...new Set([...this.filesByPid.values()].flatMap((s) => [...s]))].sort();
  }

  private coldEvents(name: string): AcpEvent[] {
    const hit = this.coldCache.get(name);
    if (hit) {
      hit.at = ++this.coldClock;
      return hit.events;
    }
    const events = this.readFileEventsSync(name);
    const bytes = events.reduce((n, e) => n + e.raw.length + 64, 0);
    if (events.length > 0 && bytes <= this.maxColdBytes) {
      this.coldCache.set(name, { events, bytes, at: ++this.coldClock });
      this.coldBytes += bytes;
      this.evictCold();
    }
    return events;
  }

  private evictCold(): void {
    if (this.coldBytes <= this.maxColdBytes) return;
    const entries = [...this.coldCache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [name, entry] of entries) {
      if (this.coldBytes <= this.maxColdBytes) break;
      this.coldCache.delete(name);
      this.coldBytes -= entry.bytes;
    }
  }

  /**
   * Keep the cold cache of a pid's active file current as events stream in,
   * instead of invalidating it (which would force re-reading a growing file on
   * every live detail refresh). The tail ingests in order, so appending keeps
   * the cached slice identical to the file content.
   */
  private extendColdForPid(event: AcpEvent): void {
    const name = this.activeFileByPid.get(event.bridgePid);
    if (!name) return;
    const entry = this.coldCache.get(name);
    if (!entry) return;
    entry.events.push(event);
    entry.bytes += event.raw.length + 64;
    entry.at = ++this.coldClock;
    this.coldBytes += event.raw.length + 64;
    this.evictCold();
  }

  private readFileEventsSync(name: string): AcpEvent[] {
    try {
      const text = readFileSync(path.join(this.dir, name), "utf8");
      const out: AcpEvent[] = [];
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          out.push(JSON.parse(trimmed) as AcpEvent);
        } catch {
          // skip corrupt line
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private async readFileEvents(name: string): Promise<AcpEvent[]> {
    try {
      const text = await fs.readFile(path.join(this.dir, name), "utf8");
      const out: AcpEvent[] = [];
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          out.push(JSON.parse(trimmed) as AcpEvent);
        } catch {
          // skip corrupt line
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /* ---- lifecycle -------------------------------------------- */

  async load(): Promise<AcpEvent[]> {
    await this.cleanupStaleMigration();
    await this.migrateLegacy();
    await fs.mkdir(this.dir, { recursive: true });
    await this.enforceRetention();
    this.ring = [];
    this.summaryState.clear();
    this.filesByPid.clear();
    this.activeFileByPid.clear();
    this.coldCache.clear();
    this.coldBytes = 0;
    this.pendingChunk = null;

    const names = (await fs.readdir(this.dir)).filter((n) => n.endsWith(".jsonl")).sort();
    for (const name of names) {
      const pid = pidFromFileName(name);
      if (pid != null) {
        let files = this.filesByPid.get(pid);
        if (!files) {
          files = new Set();
          this.filesByPid.set(pid, files);
        }
        files.add(name);
        this.activeFileByPid.set(pid, name);
      }
      const events = await this.readFileEvents(name);
      for (const event of events) this.absorb(event, false);
    }
    return this.list();
  }

  async clear(): Promise<void> {
    this.ring = [];
    this.summaryState.clear();
    this.filesByPid.clear();
    this.activeFileByPid.clear();
    this.coldCache.clear();
    this.coldBytes = 0;
    this.pendingChunk = null;
    try {
      await fs.rm(this.dir, { recursive: true, force: true });
    } catch {
      // dir may not exist
    }
  }

  /**
   * Delete one conversation (all shard files for `bridgePid`) from disk and
   * memory. Returns false when the pid is unknown. Does not stop a live
   * bridge process — if it keeps appending, the record can reappear.
   */
  async deleteByPid(pid: number): Promise<boolean> {
    const files = this.filesByPid.get(pid);
    const known = (files != null && files.size > 0) || this.summaryState.has(pid);
    if (!known) return false;
    const names = [...(files ?? [])];
    for (const name of names) {
      try {
        await fs.unlink(path.join(this.dir, name));
      } catch {
        // already gone
      }
    }
    if (this.pendingChunk?.bridgePid === pid) this.pendingChunk = null;
    this.ring = this.ring.filter((event) => event.bridgePid !== pid);
    if (names.length > 0) this.pruneIndexes(names);
    this.filesByPid.delete(pid);
    this.activeFileByPid.delete(pid);
    this.summaryState.delete(pid);
    return true;
  }

  /** Delete conversation files idle longer than maxDays. */
  async enforceRetention(now = Date.now()): Promise<string[]> {
    const cutoff = now - this.maxDays * 86_400_000;
    const removed: string[] = [];
    let names: string[];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => n.endsWith(".jsonl"));
    } catch {
      return removed;
    }
    for (const name of names) {
      const filePath = path.join(this.dir, name);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(filePath);
          removed.push(name);
        }
      } catch {
        // file vanished meanwhile
      }
    }
    if (removed.length > 0) {
      this.pruneIndexes(removed);
      console.log(`AcpEventStore retention: removed ${removed.length} conversation file(s) older than ${this.maxDays} day(s)`);
    }
    return removed;
  }

  /**
   * One-time compaction: rewrite every conversation file with chunk
   * aggregation applied, so legacy/unaggregated data shrinks like live
   * appends do. Idempotent — already-aggregated events (chunkCount) are
   * re-merged correctly and non-chunk events pass through untouched.
   *
   * Files modified within `skipRecentMs` are skipped (a live bridge may still
   * be appending to them) and reported. Each file is replaced atomically
   * (tmp + rename).
   */
  async compactAll(skipRecentMs = 60_000): Promise<{
    files: number;
    skipped: string[];
    linesBefore: number;
    linesAfter: number;
    bytesBefore: number;
    bytesAfter: number;
  }> {
    let names: string[];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => n.endsWith(".jsonl")).sort();
    } catch {
      return { files: 0, skipped: [], linesBefore: 0, linesAfter: 0, bytesBefore: 0, bytesAfter: 0 };
    }
    const stats = {
      files: 0,
      skipped: [] as string[],
      linesBefore: 0,
      linesAfter: 0,
      bytesBefore: 0,
      bytesAfter: 0,
    };
    const cutoff = Date.now() - skipRecentMs;
    for (const name of names) {
      const filePath = path.join(this.dir, name);
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue; // vanished
      }
      if (stat.mtimeMs > cutoff) {
        stats.skipped.push(name);
        continue;
      }
      const text = await fs.readFile(filePath, "utf8");
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      stats.linesBefore += lines.length;
      stats.bytesBefore += text.length;
      const events = lines.map((l) => JSON.parse(l) as AcpEvent);
      const compacted = aggregateChunkLines(events);
      const out = compacted.map((e) => JSON.stringify(e)).join("\n") + "\n";
      const tmp = `${filePath}.compact.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      await fs.writeFile(tmp, out, "utf8");
      await fs.rename(tmp, filePath);
      stats.files++;
      stats.linesAfter += compacted.length;
      stats.bytesAfter += out.length;
    }
    // In-memory state (ring/summaries/caches) is now stale if this store was
    // also being used — reload to resync.
    if (stats.files > 0) {
      await this.load();
    }
    return stats;
  }

  private pruneIndexes(removed: string[]): void {
    const gone = new Set(removed);
    for (const [pid, files] of this.filesByPid) {
      for (const name of files) {
        if (gone.has(name)) files.delete(name);
      }
      if (files.size === 0) {
        this.filesByPid.delete(pid);
        this.activeFileByPid.delete(pid);
        this.summaryState.delete(pid);
      }
    }
    for (const name of gone) {
      const entry = this.coldCache.get(name);
      if (entry) this.coldBytes -= entry.bytes;
      this.coldCache.delete(name);
    }
  }

  subscribe(listener: (event: AcpEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /* ---- legacy migration ------------------------------------- */

  private async cleanupStaleMigration(): Promise<void> {
    const migrating = `${this.dir}.migrating`;
    try {
      await fs.rm(migrating, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  private async migrateLegacy(): Promise<void> {
    // Nothing to migrate if the legacy single file is missing or empty.
    let legacySize = 0;
    try {
      legacySize = (await fs.stat(this.eventsPath)).size;
    } catch {
      return;
    }
    if (legacySize === 0) return;

    // Merge into a fresh staging dir, then fold any existing shards in and
    // rename. This also covers a legacy file re-created AFTER migration (e.g.
    // by a still-running old-code bridge): its events land in new files next
    // to the existing ones instead of being lost.
    const migrating = `${this.dir}.migrating`;
    await fs.rm(migrating, { recursive: true, force: true });
    await fs.mkdir(migrating, { recursive: true });

    let migrated = 0;
    let skipped = 0;
    let lastPid: number | null = null;
    let lastStartTs = "";
    const writers = new Map<number, ReturnType<typeof createWriteStream>>();
    const closeWriter = (pid: number | null) => {
      if (pid == null) return;
      const w = writers.get(pid);
      if (w) {
        w.end();
        writers.delete(pid);
      }
    };

    await new Promise<void>((resolve, reject) => {
      const rl = createInterface({ input: createReadStream(this.eventsPath), crlfDelay: Infinity });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: AcpEvent;
        try {
          event = JSON.parse(trimmed) as AcpEvent;
        } catch {
          skipped++;
          return;
        }
        const pid = event.bridgePid;
        if (event.kind === "process_start") {
          // A process_start always begins a conversation: seal any previous
          // file of this pid (covers recycled pids) and start a new one.
          closeWriter(pid);
          lastStartTs = sanitizeTs(event.ts);
        } else if (pid !== lastPid) {
          closeWriter(lastPid);
          lastStartTs = sanitizeTs(event.ts);
        }
        lastPid = pid;
        if (!lastStartTs) lastStartTs = sanitizeTs(event.ts);
        let w = writers.get(pid);
        if (!w) {
          w = createWriteStream(path.join(migrating, `${pid}-${lastStartTs}.jsonl`), {
            flags: "a",
          });
          writers.set(pid, w);
        }
        w.write(`${trimmed}\n`);
        migrated++;
      });
      rl.on("close", () => resolve());
      rl.on("error", reject);
    });
    const finishes = [...writers.values()].map(
      (w) => new Promise<void>((res) => w.on("finish", () => res())),
    );
    for (const pid of writers.keys()) closeWriter(pid);
    await Promise.all(finishes);

    // Fold pre-existing shards into the staging dir (name collisions with a
    // freshly migrated file are not expected; keep the existing file).
    let existingNames: string[] = [];
    try {
      existingNames = (await fs.readdir(this.dir)).filter((n) => n.endsWith(".jsonl"));
    } catch {
      // no existing shard dir
    }
    for (const name of existingNames) {
      const dest = path.join(migrating, name);
      try {
        await fs.access(dest);
      } catch {
        await fs.copyFile(path.join(this.dir, name), dest);
      }
    }

    if (migrated > 0) {
      await fs.rm(this.dir, { recursive: true, force: true });
      await fs.rename(migrating, this.dir);
      await fs.unlink(this.eventsPath);
      console.log(
        `AcpEventStore: migrated ${migrated} event(s) from ${path.basename(this.eventsPath)} into ${this.dir} (${skipped} corrupt line(s) skipped); legacy file removed`,
      );
    } else {
      // Legacy had content but no parseable events (all corrupt): keep the
      // existing shards, drop the staging dir, leave the legacy file.
      await fs.rm(migrating, { recursive: true, force: true });
    }
  }
}
