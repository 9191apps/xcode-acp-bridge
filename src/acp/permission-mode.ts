/**
 * YOLO auto-approval for the agent's `session/request_permission` requests.
 *
 * Without yolo the bridge is transparent here: the request is forwarded to Xcode and Xcode's
 * approval gate answers it. With yolo enabled (route or top-level `yolo: true` in
 * acp-bridge.config.json) the bridge answers the request itself, so the agent's tool call runs
 * without any human prompt.
 *
 * Two invariants keep this from making things worse:
 *   - The request line stays in the JSONL (it was logged before this decision), and the synthesized
 *     reply is logged as a bridge-owned c2a line, so the Observatory shows exactly what was approved.
 *   - Fail open. Anything unexpected (not a permission request, no id to answer, no allow option)
 *     returns null and the line is forwarded to Xcode as usual.
 */

export type PermissionOption = { optionId: string; kind: string | null };

export type AutoApproval = {
  /** Full JSON-RPC response line to write back to the agent's stdin. */
  reply: string;
  optionId: string;
  /** ACP `kind` of the chosen option; null when the agent omitted it. */
  optionKind: string | null;
  sessionId: string | null;
};

/**
 * Preference order for the ACP `kind` values a spec-conforming agent sends. `allow_always` comes
 * first: it is the same grant with fewer round trips, because the agent then stops asking.
 */
const ALLOW_KIND_ORDER = ["allow_always", "allow_once"];

/**
 * Agents that send non-spec option ids without a `kind` (Cursor's `allow-once`, older variants).
 * Matched case-insensitively, exact first.
 */
const ALLOW_ID_HINTS = ["allow-always", "allow_always", "allow-once", "allow_once", "allow", "approve"];

/** Pick the option that grants access, or null when the request offers only rejections. */
export function pickAllowOption(options: unknown): PermissionOption | null {
  if (!Array.isArray(options)) return null;
  const parsed: PermissionOption[] = [];
  for (const raw of options) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const optionId = (raw as { optionId?: unknown }).optionId;
    if (typeof optionId !== "string" || optionId.length === 0) continue;
    const kind = (raw as { kind?: unknown }).kind;
    parsed.push({ optionId, kind: typeof kind === "string" ? kind : null });
  }
  if (parsed.length === 0) return null;

  for (const kind of ALLOW_KIND_ORDER) {
    const match = parsed.find((option) => option.kind === kind);
    if (match) return match;
  }

  for (const hint of ALLOW_ID_HINTS) {
    const match = parsed.find((option) => option.optionId.toLowerCase() === hint);
    if (match) return match;
  }

  return parsed.find((option) => /allow|approve|accept/.test(option.optionId.toLowerCase())) ?? null;
}

/**
 * Build the auto-approval reply for an agent→client permission request, or null when the line should
 * be forwarded to Xcode unchanged.
 */
export function autoApprovePermissionLine(line: string): AutoApproval | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const msg = parsed as { id?: unknown; method?: unknown; params?: unknown };
  if (msg.method !== "session/request_permission") return null;
  const id = msg.id;
  // A request without an id is a notification: there is nothing to answer.
  if (typeof id !== "string" && typeof id !== "number") return null;

  const params = msg.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const picked = pickAllowOption((params as { options?: unknown }).options);
  if (picked === null) return null;

  const sessionId = (params as { sessionId?: unknown }).sessionId;

  return {
    reply: JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { outcome: { outcome: "selected", optionId: picked.optionId } },
    }),
    optionId: picked.optionId,
    optionKind: picked.kind,
    sessionId: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null,
  };
}
