import { countAcpImagesFromRaw } from "./content-blocks";
import { extractRpcMeta } from "./parse";
import { pickRepresentative } from "./session-list-group";
import type { AcpEvent } from "./types";

export type ConversationStatus = "live" | "stale" | "ended" | "error";

export type ConversationSummary = {
  bridgePid: number;
  backendPid: number | null;
  route: string | null;
  cwd: string | null;
  mcpXcodeSessionId: string | null;
  acpSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string;
  status: ConversationStatus;
  durationMs: number;
  promptCount: number;
  toolCallCount: number;
  eventCount: number;
  model: string | null;
};

export type TimelineItem =
  | {
      type: "process";
      kind: "process_start" | "process_start_error" | "process_end";
      ts: string;
      eventId: string;
      route: string | null;
      raw: string;
      durationMs: number | null;
      gapMs: number | null;
      bridgePid: number;
    }
  | {
      type: "rpc";
      method: string;
      dir: "c2a" | "a2c" | null;
      rpcId: string | number | null;
      ts: string;
      eventId: string;
      raw: string;
      durationMs: number | null;
      gapMs: number | null;
      imageCount: number;
      bridgePid: number;
    }
  | {
      type: "tool_call";
      name: string;
      ts: string;
      lastTs: string;
      eventId: string;
      updateCount: number;
      dir: "c2a" | "a2c" | null;
      raw: string;
      durationMs: number | null;
      gapMs: number | null;
      imageCount: number;
      bridgePid: number;
    }
  | {
      type: "chunks";
      update: string;
      count: number;
      firstTs: string;
      lastTs: string;
      eventIds: string[];
      dir: "c2a" | "a2c" | null;
      text: string;
      raw: string;
      durationMs: number | null;
      gapMs: number | null;
      bridgePid: number;
    };

export type ConversationDetail = ConversationSummary & { timeline: TimelineItem[] };

export type SessionDetail = ConversationSummary & {
  kind: "session";
  acpSessionId: string;
  spawns: ConversationSummary[];
  representativeBridgePid: number;
  liveBridgePid: number | null;
  timeline: TimelineItem[];
};

const PROCESS_KINDS = new Set<AcpEvent["kind"]>(["process_start", "process_start_error", "process_end"]);
export const CHUNK_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk"]);

function eventSeq(id: string): number | null {
  const dash = id.lastIndexOf("-");
  if (dash < 0) return null;
  const n = Number(id.slice(dash + 1));
  return Number.isFinite(n) ? n : null;
}

function compareTsThenId(a: AcpEvent, b: AcpEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  const sa = eventSeq(a.id);
  const sb = eventSeq(b.id);
  if (sa != null && sb != null && sa !== sb) return sa - sb;
  return 0;
}

export function hydrateEvent(event: AcpEvent): AcpEvent {
  if (event.raw.length === 0) return event;
  try {
    const meta = extractRpcMeta(JSON.parse(event.raw));
    return {
      ...event,
      cwd: event.cwd ?? meta.cwd,
      mcpXcodeSessionId: event.mcpXcodeSessionId ?? meta.mcpXcodeSessionId,
      sessionUpdate: event.sessionUpdate ?? meta.sessionUpdate,
      toolName: event.toolName ?? meta.toolName,
      sessionHints: event.sessionHints.length > 0 ? event.sessionHints : meta.sessionHints,
      modelCurrent: event.modelCurrent ?? meta.modelCurrent,
      modelCount: event.modelCount ?? meta.modelCount,
    };
  } catch {
    return event;
  }
}

function routeFromProcessStart(event: AcpEvent): string | null {
  if (typeof event.route === "string") return event.route;
  if (event.raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(event.raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const route = (parsed as Record<string, unknown>).route;
      if (typeof route === "string") return route;
    }
  } catch {
    // ignore malformed process_start raw
  }
  return null;
}

export function chunkTextFromRaw(raw: string): string {
  if (raw.length === 0) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const params = (parsed as Record<string, unknown>).params;
    if (params === null || typeof params !== "object" || Array.isArray(params)) return "";
    const update = (params as Record<string, unknown>).update;
    if (update === null || typeof update !== "object" || Array.isArray(update)) return "";
    const content = (update as Record<string, unknown>).content;
    if (typeof content === "string") return content;
    if (content !== null && typeof content === "object" && !Array.isArray(content)) {
      const text = (content as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
  } catch {
    // ignore
  }
  return "";
}

function firstNonNull<T>(events: AcpEvent[], pick: (event: AcpEvent) => T | null | undefined): T | null {
  for (const event of events) {
    const value = pick(event);
    if (value != null) return value;
  }
  return null;
}

function lastNonNull<T>(events: AcpEvent[], pick: (event: AcpEvent) => T | null | undefined): T | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const value = pick(events[i]!);
    if (value != null) return value;
  }
  return null;
}

function hydrateAndSort(events: AcpEvent[]): AcpEvent[] {
  const hydrated = events.map(hydrateEvent);
  hydrated.sort(compareTsThenId);
  return hydrated;
}

function groupByBridgePid(events: AcpEvent[]): Map<number, AcpEvent[]> {
  const groups = new Map<number, AcpEvent[]>();
  for (const event of events) {
    const list = groups.get(event.bridgePid);
    if (list) list.push(event);
    else groups.set(event.bridgePid, [event]);
  }
  for (const [pid, list] of groups) {
    groups.set(pid, hydrateAndSort(list));
  }
  return groups;
}

function msBetween(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function itemStartTs(item: TimelineItem): string {
  return item.type === "chunks" ? item.firstTs : item.ts;
}

function itemEndTs(item: TimelineItem): string {
  if (item.type === "chunks") return item.lastTs;
  if (item.type === "tool_call") return item.lastTs;
  return item.ts;
}

function enrichTimeline(timeline: TimelineItem[]): TimelineItem[] {
  const requestTsByRpcId = new Map<string, string>();
  for (const item of timeline) {
    if (item.type === "rpc" && item.dir === "c2a" && item.rpcId != null) {
      requestTsByRpcId.set(String(item.rpcId), item.ts);
    }
  }

  let prevEnd: string | null = null;
  return timeline.map((item) => {
    const gapMs = prevEnd == null ? null : msBetween(prevEnd, itemStartTs(item));
    let durationMs: number | null = null;
    if (item.type === "chunks") {
      durationMs = msBetween(item.firstTs, item.lastTs);
    } else if (item.type === "tool_call") {
      durationMs = msBetween(item.ts, item.lastTs);
    } else if (item.type === "rpc" && item.dir === "a2c" && item.rpcId != null) {
      const requestTs = requestTsByRpcId.get(String(item.rpcId));
      if (requestTs) durationMs = msBetween(requestTs, item.ts);
    }
    prevEnd = itemEndTs(item);
    return { ...item, durationMs, gapMs };
  });
}

function summarizeGroup(bridgePid: number, events: AcpEvent[]): ConversationSummary {
  const processStart = events.find((event) => event.kind === "process_start");
  const processEnd = events.find((event) => event.kind === "process_end");
  const processStartError = events.find((event) => event.kind === "process_start_error");
  const mcpXcodeSessionId = firstNonNull(events, (event) => event.mcpXcodeSessionId);
  const acpSessionId =
    events.flatMap((event) => event.sessionHints).find((hint) => hint !== mcpXcodeSessionId) ?? null;

  let status: ConversationStatus = "live";
  if (processStartError) status = "error";
  else if (processEnd) status = "ended";

  const startedAt = processStart?.ts ?? events[0]!.ts;
  const endedAt = processEnd?.ts ?? processStartError?.ts ?? null;
  // Active span: ignore idle tail after the last real ACP traffic (and ignore
  // process_end, which often arrives much later when Xcode finally closes stdio).
  const lastActivity =
    [...events].reverse().find((event) => event.kind !== "process_end") ?? events[events.length - 1]!;
  const lastActivityAt = lastActivity.ts;
  const durationMs = msBetween(startedAt, lastActivityAt) ?? 0;

  return {
    bridgePid,
    backendPid: firstNonNull(events, (event) => event.backendPid),
    route: processStart ? routeFromProcessStart(processStart) : null,
    model: lastNonNull(events, (event) => event.modelCurrent),
    cwd: firstNonNull(events, (event) => event.cwd),
    mcpXcodeSessionId,
    acpSessionId,
    startedAt,
    endedAt,
    lastActivityAt,
    status,
    durationMs,
    promptCount: events.filter((event) => event.method === "session/prompt").length,
    toolCallCount: events.filter((event) => event.sessionUpdate === "tool_call").length,
    eventCount: events.length,
  };
}

function sameSpawn(last: TimelineItem | undefined, event: AcpEvent): boolean {
  return last != null && last.bridgePid === event.bridgePid;
}

function buildTimeline(events: AcpEvent[]): TimelineItem[] {
  const timeline: TimelineItem[] = [];

  for (const event of events) {
    if (PROCESS_KINDS.has(event.kind)) {
      timeline.push({
        type: "process",
        kind: event.kind,
        ts: event.ts,
        eventId: event.id,
        route: event.kind === "process_start" ? routeFromProcessStart(event) : (event.route ?? null),
        raw: event.raw,
        durationMs: null,
        gapMs: null,
        bridgePid: event.bridgePid,
      });
      continue;
    }

    if (event.sessionUpdate === "tool_call") {
      timeline.push({
        type: "tool_call",
        name: event.toolName ?? "tool_call",
        ts: event.ts,
        lastTs: event.ts,
        eventId: event.id,
        updateCount: 0,
        dir: event.dir,
        raw: event.raw,
        durationMs: null,
        gapMs: null,
        imageCount: countAcpImagesFromRaw(event.raw),
        bridgePid: event.bridgePid,
      });
      continue;
    }

    if (event.sessionUpdate === "tool_call_update") {
      const last = timeline.at(-1);
      if (last?.type === "tool_call" && sameSpawn(last, event)) {
        last.updateCount += 1;
        last.raw = event.raw;
        last.lastTs = event.ts;
        last.imageCount = countAcpImagesFromRaw(event.raw);
        if (event.dir) last.dir = event.dir;
      } else {
        timeline.push({
          type: "tool_call",
          name: event.toolName ?? "tool_call_update",
          ts: event.ts,
          lastTs: event.ts,
          eventId: event.id,
          updateCount: 0,
          dir: event.dir,
          raw: event.raw,
          durationMs: null,
          gapMs: null,
          imageCount: countAcpImagesFromRaw(event.raw),
          bridgePid: event.bridgePid,
        });
      }
      continue;
    }

    if (event.sessionUpdate && CHUNK_UPDATES.has(event.sessionUpdate)) {
      // Aggregated events (written by the store) already carry the merged text
      // and count; raw chunk events contribute one piece each.
      const piece = event.chunkText ?? chunkTextFromRaw(event.raw);
      const count = event.chunkCount ?? 1;
      const last = timeline.at(-1);
      if (last?.type === "chunks" && last.update === event.sessionUpdate && sameSpawn(last, event)) {
        last.count += count;
        last.lastTs = event.chunkLastTs ?? event.ts;
        last.eventIds.push(event.id);
        last.raw = event.raw;
        last.text += piece;
        if (event.dir) last.dir = event.dir;
      } else {
        timeline.push({
          type: "chunks",
          update: event.sessionUpdate,
          count,
          firstTs: event.ts,
          lastTs: event.chunkLastTs ?? event.ts,
          eventIds: [event.id],
          dir: event.dir,
          text: piece,
          raw: event.raw,
          durationMs: null,
          gapMs: null,
          bridgePid: event.bridgePid,
        });
      }
      continue;
    }

    timeline.push({
      type: "rpc",
      method: event.method ?? event.kind,
      dir: event.dir,
      rpcId: event.rpcId,
      ts: event.ts,
      eventId: event.id,
      raw: event.raw,
      durationMs: null,
      gapMs: null,
      imageCount: countAcpImagesFromRaw(event.raw),
      bridgePid: event.bridgePid,
    });
  }

  return enrichTimeline(timeline);
}

function aggregateSpawnStatus(spawns: ConversationSummary[]): ConversationStatus {
  if (spawns.some((s) => s.status === "live")) return "live";
  if (spawns.some((s) => s.status === "error")) return "error";
  if (spawns.some((s) => s.status === "stale")) return "stale";
  return "ended";
}

export function summarizeConversations(events: AcpEvent[]): ConversationSummary[] {
  const groups = groupByBridgePid(events);
  return [...groups.entries()]
    .map(([bridgePid, grouped]) => summarizeGroup(bridgePid, grouped))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

export function conversationDetail(events: AcpEvent[], bridgePid: number): ConversationDetail | null {
  const subset = events.filter((event) => event.bridgePid === bridgePid);
  if (subset.length === 0) return null;
  const grouped = hydrateAndSort(subset);
  return {
    ...summarizeGroup(bridgePid, grouped),
    timeline: buildTimeline(grouped),
  };
}

/** Concatenate per-spawn timelines in `startedAt` order. Do not globally re-sort. */
export function sessionDetailFromSpawns(
  sessionId: string,
  spawns: ConversationSummary[],
  eventsFor: (pid: number) => AcpEvent[],
): SessionDetail | null {
  const matching = spawns.filter((s) => s.acpSessionId === sessionId);
  if (matching.length === 0) return null;
  const ordered = [...matching].sort((a, b) =>
    a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
  );
  const concatenated: AcpEvent[] = [];
  for (const spawn of ordered) {
    concatenated.push(...hydrateAndSort(eventsFor(spawn.bridgePid)));
  }
  const representative = pickRepresentative(ordered);
  const live = ordered.filter((s) => s.status === "live");
  const liveBridgePid = live.length > 0 ? pickRepresentative(live).bridgePid : null;
  const startedAt = ordered.reduce((min, s) => (s.startedAt < min ? s.startedAt : min), ordered[0]!.startedAt);
  const lastActivityAt = ordered.reduce(
    (max, s) => (s.lastActivityAt > max ? s.lastActivityAt : max),
    ordered[0]!.lastActivityAt,
  );
  const allEnded = ordered.every((s) => s.endedAt != null);
  const endedAt = allEnded
    ? ordered.reduce((max, s) => ((s.endedAt ?? "") > max ? (s.endedAt ?? "") : max), ordered[0]!.endedAt ?? "")
    : null;

  return {
    kind: "session",
    acpSessionId: sessionId,
    spawns: ordered,
    representativeBridgePid: representative.bridgePid,
    liveBridgePid,
    bridgePid: representative.bridgePid,
    backendPid: representative.backendPid,
    route: representative.route,
    cwd: representative.cwd,
    mcpXcodeSessionId: representative.mcpXcodeSessionId,
    startedAt,
    endedAt,
    lastActivityAt,
    status: aggregateSpawnStatus(ordered),
    durationMs: Math.max(0, Date.parse(lastActivityAt) - Date.parse(startedAt)) || 0,
    promptCount: ordered.reduce((n, s) => n + s.promptCount, 0),
    toolCallCount: ordered.reduce((n, s) => n + s.toolCallCount, 0),
    eventCount: ordered.reduce((n, s) => n + s.eventCount, 0),
    model: representative.model,
    timeline: buildTimeline(concatenated),
  };
}
