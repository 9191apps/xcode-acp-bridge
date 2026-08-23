# ACP Event Storage — Design

**Date:** 2026-08-16
**Status:** implemented (user decisions: per-conversation files, 30-day retention)

## Goal

Replace the single unbounded `data/acp-events.jsonl` (241 MB / 357k events after 3 days) with a storage mechanism that keeps:

- **memory bounded** — never hold the whole history resident;
- **disk bounded** — old conversations are trimmed by retention;
- **startup cheap** — one streaming scan, no full-file parse into RAM;
- **tail cheap** — byte-offset incremental reads, no full reload every 250 ms;
- **queries cheap** — conversation list/detail no longer scan all events per request.

## Context (current implementation, before this change)

- `acp-bridge.config.json` sets `eventsPath: "./data/acp-events.jsonl"`.
- The **bridge process** (`src/acp/run-bridge.ts`) tees every JSON-RPC line via `store.append(event)` — one JSON object per line, append-only, into a single file.
- The **dashboard process** (`src/index.ts`) builds its own `AcpEventStore` on the same path, calls `load()` (parses the **entire** file into memory) and `startAcpTail` polls the file every 250 ms — on any growth it **re-parses the whole file** and diffs by id.
- API routes scan everything per request: `summarizeConversations(store.list())` (list), `conversationDetail(store.list(), pid)` (detail, O(N) filter), `store.getById(id)` (linear find).

### Measured reality (2026-08-14 → 08-16)

| metric | value |
|---|---|
| events | 357,257 |
| bytes | 240,919,480 |
| conversations (`bridgePid`) | **12** |
| max events in one conversation | 155,503 (chunk flood) |
| kind mix | 99.99% `rpc` (mostly `session/update` chunks) |

→ The data is *few conversations, each with huge event counts*. Per-conversation files make retention, cold reads and export trivial; summary computation is cheap if maintained incrementally.

## Design

### 1. Storage layout — one JSONL file per conversation

```
data/
  acp-events/                      ← derived from eventsPath by stripping the extension
    38291-20260814T153831Z.jsonl   ← one Xcode spawn / bridgePid (pid + start ts)
    40810-20260814T153913Z.jsonl
    14087-2026-08-16T08-55-56.599Z.jsonl
```

- `eventsPath` config key **stays the same**; the store derives the dir: `path.join(dirname(eventsPath), basename(eventsPath, ".jsonl"))`.
- Both processes (bridge writer, dashboard reader) share the `AcpEventStore` class, so appends land in the same per-conversation files. File names are `<bridgePid>-<sanitized process_start ts>.jsonl` — unique even when the OS recycles a pid (a new `process_start` opens a new file).
- **Migration (one-time, resilient):** on `load()`, if the legacy `acp-events.jsonl` exists, it is streamed (line-by-line, no full-file string) into a `.migrating` staging dir, split at `process_start` boundaries (also handling recycled pids), existing shards are folded in, the dir is atomically renamed, and the legacy file is removed. A legacy file **re-created after** shards exist (e.g. a still-running old-code bridge) is merged on the next boot rather than ignored. Verified on the real 241 MB file: 361,624 events → 18 files, 0 lost.

### 2. Memory model — hot ring + incremental summary cache, cold from disk

- **Hot ring:** newest `MAX_ACP_EVENTS` events (default **20,000**, env `MAX_ACP_EVENTS`) — live sessions, recent timelines, raw panes. ~15 MB instead of hundreds of MB resident.
- **Conversation summary cache:** `Map<bridgePid, ConversationSummary>` maintained **O(1) per event**:
  - structural fields (route / cwd / session ids / startedAt / status) set from `process_start` / first events — first `process_start` wins;
  - counters (`promptCount`, `toolCallCount`, `eventCount`), `lastActivityAt` (excluding `process_end`) and `model` updated per event.
  - Seeded by the startup scan; after that `/api/acp-conversations` is a cache read — no full scans.
- **Cold events** (fell out of the ring) are read from the conversation's file on demand, cached in an **LRU byte-bounded cache** (`MAX_ACP_COLD_MB`, default 200) and kept current by **appending** streamed events into the cached slice — so live detail of a growing conversation never re-reads the file.

### 3. Disk reads

- `detail(pid)`: ring events for pid ∪ cold events from the pid's files (dedupe by id), then the existing `conversations.conversationDetail`/`buildTimeline` (chunk rows collapsed). Measured: 155k-event conversation → 277 ms first cold read, ~160 ms repeat (cache hit); timeline collapses to ~650 rows.
- `getById(id)`: ring first; cold fallback via pid parsed from the event id (`<pid>-N`), scanning the pid's files. Used by the raw-pane.
- `exportAll()`: concatenates all files in order (`/api/acp-events/export`).

### 4. Retention

- `MAX_ACP_DAYS` (default **30**, env-tunable): on startup (`load()`) and on demand, delete conversation files whose **mtime** (last write = last activity) is older than the window; evict their summaries and cold cache entries.
- Disk bounded to ≈ 30 days × traffic. Live conversations are never idle, so they are never trimmed.

### 5. Tail — byte-offset multi-file incremental reads

- `startAcpTail` watches **all** conversation files in the shard dir; each poll stats files (cheap) and reads **only the bytes appended since the last poll** per file (new files picked up from size 0, truncated files detected by size regression and restarted, partial trailing lines buffered until complete).
- The first pass only records sizes — pre-existing history is **not** re-emitted (the store already loaded it).
- External events are `ingest()`ed into ring + summary cache without disk writes and without double-publishing (the tail's `onEvent` is the single SSE path for external events).

### 6. Chunk aggregation (default ON)

opencode streams `session/update` as very fine-grained chunks (`agent_thought_chunk` / `agent_message_chunk`): the 4.5 h / 18-prompt conversation measured here produced **154,372 chunk events (99% of all events)** averaging 678 bytes — one event per thought token.

`AcpEventStore.append` therefore buffers **consecutive same-type chunk updates** and writes them as a **single aggregated event** (`chunkCount`, `chunkText` concatenated, `chunkLastTs`, `raw` = last chunk's raw, `id` = first chunk's id). The group flushes on the next non-chunk event (e.g. `session/prompt`, `process_end`), on an update-type / pid change, or when it hits `maxChunkEvents` (default 2000) / `maxChunkBytes` (default 512 KB) — so a hard crash loses at most one bounded group.

Result on the real conversation: 155,503 lines / 100.6 MB → **1,475 lines / 3.77 MB (-96.3%)**, timeline still shows exact chunk counts (the builder adds `chunkCount` when merging rows). Disable with `MAX_ACP_CHUNK_AGGREGATE=0` (env) or `aggregateChunks: false` (store opt). Old data is untouched — `compactAll()` (via `bun run scripts/compact-acp.ts`) rewrites legacy files with aggregation applied; it skips files modified in the last minute (possible live writer), is idempotent, and replaces each file atomically. Real run: 19 files / 361,624 events / 233 MB → 5,323 lines / 11.19 MB (-95.2%), with chunk totals preserved exactly (357,016) and non-chunk events 1:1.

### 7. API & compatibility

- `AcpEventStore` public surface: `append / load / list (ring) / summaries / detail(pid) / getById / exportAll / clear / subscribe / ingest`. `run-bridge.ts` (`append`) and `index.ts` (`load`, `startAcpTail`) call sites unchanged; dashboard routes switched to `store.summaries()` / `store.detail(pid)` / `store.exportAll()`.
- `session-models` / `commands` derive paths from `dirname(eventsPath)` → unchanged (`data/`).
- `clear()` removes the shard dir and resets all caches.

### 8. Testing

- Rewritten `tests/acp-event-store.test.ts`: shard layout, per-conversation files, recycled-pid splitting, migration (first boot + legacy-recreated merge), ring cap, incremental summaries beyond the ring, cold detail, retention, export, subscribe, chunk aggregation (merge, type-change flush, cap flush, disable, replay through load).
- New `tests/acp-tail.test.ts`: initial-pass no-emit, byte-offset increments, partial-line buffering, truncation restart, new-file pickup.
- `tests/acp-bridge.test.ts` reads events back via a `readEvents()` helper over the shard dir; `tests/acp-dashboard.test.ts` updated for shard paths. 161 tests pass.

## Decisions

1. **Per-conversation files** (user) instead of per-day shards — matches the measured data shape (12 conversations).
2. **Retention default 30 days** (user), env `MAX_ACP_DAYS`.

## Out of scope

- SQLite or any new dependency (plain files keep the project's zero-dep philosophy).
- Compression of shards (breaks the offset tail and export simplicity).
- Splitting a single huge conversation file (a future `MAX_ACP_FILE_BYTES` could add intra-conversation segments; currently a 100+ MB conversation is read whole on cold access — ~300 ms, cached after first read).
