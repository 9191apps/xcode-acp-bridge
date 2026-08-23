function mcpXcodeSessionIdFromPair(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (rec.name !== "MCP_XCODE_SESSION_ID") return null;
  return typeof rec.value === "string" && rec.value.length > 0 ? rec.value : null;
}

function walk(value: unknown, out: Set<string>): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out);
    return;
  }
  if (typeof value !== "object") return;
  const rec = value as Record<string, unknown>;
  const fromPair = mcpXcodeSessionIdFromPair(rec);
  if (fromPair) out.add(fromPair);
  for (const [k, v] of Object.entries(rec)) {
    if ((k === "sessionId" || k === "session_id") && typeof v === "string" && v.length > 0) {
      out.add(v);
    }
    if (k === "MCP_XCODE_SESSION_ID" && typeof v === "string" && v.length > 0) {
      out.add(v);
    }
    walk(v, out);
  }
}

function findMcpXcodeSessionId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMcpXcodeSessionId(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const fromPair = mcpXcodeSessionIdFromPair(rec);
  if (fromPair) return fromPair;
  for (const [k, v] of Object.entries(rec)) {
    if (k === "MCP_XCODE_SESSION_ID" && typeof v === "string" && v.length > 0) {
      return v;
    }
    const found = findMcpXcodeSessionId(v);
    if (found) return found;
  }
  return null;
}

export function extractSessionHints(value: unknown): string[] {
  const out = new Set<string>();
  walk(value, out);
  return [...out];
}

function modeFromConfigOptions(result: unknown): { current: string | null; options: string[] } {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { current: null, options: [] };
  }
  const options = (result as Record<string, unknown>).configOptions;
  if (!Array.isArray(options)) return { current: null, options: [] };
  const modeOption = options.find((o) => {
    if (o === null || typeof o !== "object" || Array.isArray(o)) return false;
    const rec = o as Record<string, unknown>;
    return rec.category === "mode" || (rec.category == null && rec.id === "mode");
  }) as Record<string, unknown> | undefined;
  if (!modeOption) return { current: null, options: [] };
  const current =
    typeof modeOption.currentValue === "string" && modeOption.currentValue.length > 0
      ? modeOption.currentValue
      : null;
  const values = Array.isArray(modeOption.options)
    ? modeOption.options
        .filter(
          (o): o is Record<string, unknown> => o !== null && typeof o === "object" && !Array.isArray(o),
        )
        .map((o) => o.value)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  return { current, options: values };
}

function modelFromConfigOptions(result: unknown): { current: string | null; count: number | null } {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { current: null, count: null };
  }
  const options = (result as Record<string, unknown>).configOptions;
  if (!Array.isArray(options)) return { current: null, count: null };
  const modelOption = options.find((o) => {
    if (o === null || typeof o !== "object" || Array.isArray(o)) return false;
    const rec = o as Record<string, unknown>;
    return rec.category === "model" || (rec.category == null && rec.id === "model");
  }) as Record<string, unknown> | undefined;
  if (!modelOption) return { current: null, count: null };
  const current =
    typeof modelOption.currentValue === "string" && modelOption.currentValue.length > 0
      ? modelOption.currentValue
      : null;
  const count = Array.isArray(modelOption.options) ? modelOption.options.length : null;
  return { current, count };
}

export type RpcMeta = {
  cwd: string | null;
  mcpXcodeSessionId: string | null;
  sessionUpdate: string | null;
  toolName: string | null;
  sessionHints: string[];
  modelCurrent: string | null;
  modelCount: number | null;
  modeCurrent: string | null;
  modeOptions: string[];
};

export function extractRpcMeta(value: unknown): RpcMeta {
  const sessionHints = extractSessionHints(value);
  const mcpXcodeSessionId = findMcpXcodeSessionId(value);

  let cwd: string | null = null;
  let sessionUpdate: string | null = null;
  let toolName: string | null = null;
  let modelCurrent: string | null = null;
  let modelCount: number | null = null;
  let modeCurrent: string | null = null;
  let modeOptions: string[] = [];

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    const model = modelFromConfigOptions(rec.result);
    modelCurrent = model.current;
    modelCount = model.count;
    const mode = modeFromConfigOptions(rec.result);
    modeCurrent = mode.current;
    modeOptions = mode.options;
    const params = rec.params;
    if (params !== null && typeof params === "object" && !Array.isArray(params)) {
      const paramsRec = params as Record<string, unknown>;
      if (typeof paramsRec.cwd === "string" && paramsRec.cwd.length > 0) {
        cwd = paramsRec.cwd;
      }
      const update = paramsRec.update;
      if (update !== null && typeof update === "object" && !Array.isArray(update)) {
        const updateRec = update as Record<string, unknown>;
        if (typeof updateRec.sessionUpdate === "string") {
          sessionUpdate = updateRec.sessionUpdate;
        }
        if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
          for (const key of ["title", "name", "kind"] as const) {
            const candidate = updateRec[key];
            if (typeof candidate === "string" && candidate.length > 0) {
              toolName = candidate;
              break;
            }
          }
        }
      }
    }
  }

  return {
    cwd,
    mcpXcodeSessionId,
    sessionUpdate,
    toolName,
    sessionHints,
    modelCurrent,
    modelCount,
    modeCurrent,
    modeOptions,
  };
}

export function parseRpcLine(line: string, maxRawBytes: number): {
  method: string | null;
  rpcId: string | number | null;
  sessionHints: string[];
  cwd: string | null;
  mcpXcodeSessionId: string | null;
  sessionUpdate: string | null;
  toolName: string | null;
  modelCurrent: string | null;
  modelCount: number | null;
  modeCurrent: string | null;
  modeOptions: string[];
  raw: string;
  truncated: boolean;
  parseError: string | null;
} {
  const truncated = line.length > maxRawBytes;
  const raw = truncated ? line.slice(0, maxRawBytes) : line;
  try {
    const parsed = JSON.parse(line) as {
      id?: string | number;
      method?: string;
      params?: unknown;
      result?: unknown;
    };
    return {
      method: typeof parsed.method === "string" ? parsed.method : null,
      rpcId: parsed.id ?? null,
      ...extractRpcMeta(parsed),
      raw,
      truncated,
      parseError: null,
    };
  } catch (err) {
    return {
      method: null,
      rpcId: null,
      sessionHints: [],
      cwd: null,
      mcpXcodeSessionId: null,
      sessionUpdate: null,
      toolName: null,
      modelCurrent: null,
      modelCount: null,
      modeCurrent: null,
      modeOptions: [],
      raw,
      truncated,
      parseError: err instanceof Error ? err.message : "Invalid JSON",
    };
  }
}
