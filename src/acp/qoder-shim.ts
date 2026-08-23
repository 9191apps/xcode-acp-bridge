/**
 * Suppress Qoder ACP extension methods that Xcode does not implement, while
 * acknowledging requests so the agent does not wait indefinitely.
 */

export type QoderShimAction = {
  /** Do not forward the original qoder/* line to Xcode. */
  suppressOriginal: boolean;
  /** JSON-RPC response lines to write to the agent (backend stdin). */
  agentReplies: string[];
  /** Standard ACP notification lines to write to Xcode (client stdout). */
  clientNotifications: string[];
};

type JsonRpcRequest = {
  id?: string | number;
  method?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseQoderExtensionLine(line: string): JsonRpcRequest | null {
  try {
    const msg = JSON.parse(line) as unknown;
    if (!isRecord(msg)) return null;
    const method = msg.method;
    if (typeof method !== "string" || !method.startsWith("qoder/")) return null;
    return msg as JsonRpcRequest;
  } catch {
    return null;
  }
}

/**
 * Handle one a2c qoder/* line. All extension requests are acknowledged and
 * never forwarded because Xcode does not implement Qoder extension methods.
 */
export function handleQoderExtensionLine(
  line: string,
  _sessionId: string | null,
): QoderShimAction | null {
  if (!line.includes('"qoder/')) return null;
  const msg = parseQoderExtensionLine(line);
  if (msg === null) return null;

  const agentReplies =
    msg.id === undefined
      ? []
      : [
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { outcome: { outcome: "accepted" } },
          }),
        ];

  return { suppressOriginal: true, agentReplies, clientNotifications: [] };
}
