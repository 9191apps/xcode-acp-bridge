/**
 * Translate Cursor ACP extension methods into standard ACP that Xcode understands,
 * and auto-ack blocking requests so the agent turn can finish.
 *
 * Docs: https://cursor.com/docs/cli/acp
 * - Blocking: cursor/create_plan, cursor/ask_question (must JSON-RPC respond)
 * - Often sent with id even when "notification": cursor/update_todos (ack if id present)
 */

export type CursorShimAction = {
  /** Do not forward the original cursor/* line to Xcode. */
  suppressOriginal: boolean;
  /** JSON-RPC response lines to write to the agent (backend stdin). */
  agentReplies: string[];
  /** Standard ACP notification lines to write to Xcode (client stdout). */
  clientNotifications: string[];
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseCursorExtensionLine(line: string): JsonRpcRequest | null {
  try {
    const msg = JSON.parse(line) as unknown;
    if (!isRecord(msg)) return null;
    const method = msg.method;
    if (typeof method !== "string" || !method.startsWith("cursor/")) return null;
    return msg as JsonRpcRequest;
  } catch {
    return null;
  }
}

function todoLines(todos: unknown): string {
  if (!Array.isArray(todos) || todos.length === 0) return "";
  const lines: string[] = [];
  for (const t of todos) {
    if (!isRecord(t)) continue;
    const content = typeof t.content === "string" ? t.content : String(t.id ?? "");
    const status = typeof t.status === "string" ? t.status : "pending";
    const mark =
      status === "completed" ? "x" : status === "in_progress" ? "~" : status === "cancelled" ? "-" : " ";
    lines.push(`- [${mark}] ${content}`);
  }
  return lines.length > 0 ? `\n\n### Todos\n${lines.join("\n")}` : "";
}

/** Build markdown body for Xcode from cursor/create_plan params. */
export function formatCreatePlanMessage(params: Record<string, unknown>): string {
  const name = typeof params.name === "string" && params.name.length > 0 ? params.name : "Plan";
  const overview = typeof params.overview === "string" ? params.overview.trim() : "";
  const plan = typeof params.plan === "string" ? params.plan.trim() : "";
  const parts = [`## ${name}`];
  if (overview) parts.push("", overview);
  if (plan) parts.push("", plan);
  const todos = todoLines(params.todos);
  if (todos) parts.push(todos);
  return parts.join("\n");
}

function agentMessageChunk(sessionId: string, text: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

function resultLine(id: string | number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

/**
 * Handle one a2c cursor/* line. Returns null if not a cursor extension message.
 * `sessionId` is used when injecting message chunks (from last known ACP session).
 */
export function handleCursorExtensionLine(
  line: string,
  sessionId: string | null,
): CursorShimAction | null {
  const msg = parseCursorExtensionLine(line);
  if (msg === null || msg.method == null) return null;

  const method = msg.method;
  const params = isRecord(msg.params) ? msg.params : {};
  const id = msg.id;
  const sid =
    (typeof params.sessionId === "string" && params.sessionId.length > 0
      ? params.sessionId
      : null) ?? sessionId;

  if (method === "cursor/create_plan") {
    const agentReplies: string[] = [];
    if (id !== undefined) {
      // Nested outcome envelope required by Cursor ACP (flat outcome is treated as cancel).
      agentReplies.push(resultLine(id, { outcome: { outcome: "accepted" } }));
    }
    const clientNotifications: string[] = [];
    if (sid) {
      clientNotifications.push(agentMessageChunk(sid, formatCreatePlanMessage(params)));
    }
    return { suppressOriginal: true, agentReplies, clientNotifications };
  }

  if (method === "cursor/update_todos") {
    const agentReplies: string[] = [];
    if (id !== undefined) {
      const todos = Array.isArray(params.todos) ? params.todos : [];
      agentReplies.push(
        resultLine(id, {
          outcome: { outcome: "accepted", todos },
        }),
      );
    }
    // No Xcode UI for todos — drop the extension RPC; optional one-liner is noisy, skip.
    return { suppressOriginal: true, agentReplies, clientNotifications: [] };
  }

  if (method === "cursor/ask_question") {
    const agentReplies: string[] = [];
    if (id !== undefined) {
      // Auto-pick first option when present; otherwise accept empty.
      const options = Array.isArray(params.options) ? params.options : [];
      const first = options.find((o) => isRecord(o) && typeof o.id === "string") as
        | { id: string }
        | undefined;
      agentReplies.push(
        resultLine(id, {
          outcome: first
            ? { outcome: "selected", optionId: first.id }
            : { outcome: "cancelled" },
        }),
      );
    }
    const clientNotifications: string[] = [];
    if (sid) {
      const q = typeof params.question === "string" ? params.question : "Question from agent";
      clientNotifications.push(
        agentMessageChunk(sid, `_(Agent asked a question; bridge auto-answered)_\n\n${q}`),
      );
    }
    return { suppressOriginal: true, agentReplies, clientNotifications };
  }

  // Unknown cursor/* — ack empty success if request-shaped, never forward to Xcode.
  const agentReplies: string[] = [];
  if (id !== undefined) {
    agentReplies.push(resultLine(id, { outcome: { outcome: "accepted" } }));
  }
  return { suppressOriginal: true, agentReplies, clientNotifications: [] };
}
