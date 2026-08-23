import type { ConversationStatus, ConversationSummary } from "./conversations";

export type SessionListGroup =
  | {
      kind: "session";
      acpSessionId: string;
      spawns: ConversationSummary[];
      representative: ConversationSummary;
      startedAt: string;
      lastActivityAt: string;
      durationMs: number;
      status: ConversationStatus;
      promptCount: number;
      toolCallCount: number;
      route: string | null;
      model: string | null;
      cwd: string | null;
    }
  | {
      kind: "singleton";
      spawn: ConversationSummary;
    };

export function pickRepresentative(spawns: ConversationSummary[]): ConversationSummary {
  if (spawns.length === 0) {
    throw new Error("pickRepresentative: empty spawns");
  }
  const live = spawns.filter((s) => s.status === "live");
  const pool = live.length > 0 ? live : spawns;
  return pool.reduce((best, cur) =>
    cur.lastActivityAt > best.lastActivityAt ? cur : best,
  );
}

function aggregateStatus(spawns: ConversationSummary[]): ConversationStatus {
  if (spawns.some((s) => s.status === "live")) return "live";
  if (spawns.some((s) => s.status === "error")) return "error";
  if (spawns.some((s) => s.status === "stale")) return "stale";
  return "ended";
}

export function groupConversationsForList(
  rows: ConversationSummary[],
): SessionListGroup[] {
  const bySession = new Map<string, ConversationSummary[]>();
  const singletons: ConversationSummary[] = [];

  for (const row of rows) {
    const id = row.acpSessionId;
    if (id == null || id.length === 0) {
      singletons.push(row);
      continue;
    }
    const list = bySession.get(id);
    if (list) list.push(row);
    else bySession.set(id, [row]);
  }

  const groups: SessionListGroup[] = [];

  for (const [acpSessionId, spawns] of bySession) {
    const representative = pickRepresentative(spawns);
    const startedAt = spawns.reduce(
      (min, s) => (s.startedAt < min ? s.startedAt : min),
      spawns[0]!.startedAt,
    );
    const lastActivityAt = spawns.reduce(
      (max, s) => (s.lastActivityAt > max ? s.lastActivityAt : max),
      spawns[0]!.lastActivityAt,
    );
    groups.push({
      kind: "session",
      acpSessionId,
      spawns: [...spawns].sort((a, b) =>
        a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
      ),
      representative,
      startedAt,
      lastActivityAt,
      durationMs: Math.max(0, Date.parse(lastActivityAt) - Date.parse(startedAt)),
      status: aggregateStatus(spawns),
      promptCount: spawns.reduce((n, s) => n + s.promptCount, 0),
      toolCallCount: spawns.reduce((n, s) => n + (s.toolCallCount ?? 0), 0),
      route: representative.route,
      model: representative.model,
      cwd: representative.cwd,
    });
  }

  for (const spawn of singletons) {
    groups.push({ kind: "singleton", spawn });
  }

  groups.sort((a, b) => {
    const aStart = a.kind === "session" ? a.startedAt : a.spawn.startedAt;
    const bStart = b.kind === "session" ? b.startedAt : b.spawn.startedAt;
    return aStart < bStart ? 1 : aStart > bStart ? -1 : 0;
  });

  return groups;
}
