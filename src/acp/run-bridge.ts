import fs from "node:fs";
import path from "node:path";
import { AcpEventStore } from "./event-store";
import { parseRpcLine } from "./parse";
import { commandsDirFor, readModelCommand } from "./commands";
import { lookupSessionModel } from "./session-models";
import { shouldInjectPendingModelOnNew } from "./spawn-args";
import { handleCursorExtensionLine } from "./cursor-shim";
import { handleQoderExtensionLine } from "./qoder-shim";
import type { AcpDir, AcpEvent, AcpModelApply } from "./types";

export type RunBridgeOptions = {
  backendCommand: string;
  backendArgs: string[];
  eventsPath: string;
  maxRawBytes: number;
  stdin: ReadableStream<Uint8Array> | NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  bridgePid?: number;
  route?: string | null;
  pendingModel?: string | null;
  /** Default inject. spawn-arg skips entry inject after session/new (model already in argv). */
  modelApply?: AcpModelApply;
  commandsDir?: string;
};

function splitLines(onLine: (line: string) => void | Promise<void>): {
  push: (chunk: string) => void;
  flush: () => Promise<void>;
} {
  let buf = "";
  let chain = Promise.resolve();
  return {
    push(chunk: string) {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        chain = chain.then(() => onLine(line));
      }
    },
    flush() {
      if (buf.length > 0) {
        const line = buf;
        buf = "";
        chain = chain.then(() => onLine(line));
      }
      return chain;
    },
  };
}

function sessionIdFromNewResultRaw(line: string): string | null {
  try {
    const msg: unknown = JSON.parse(line);
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return null;
    const result = (msg as Record<string, unknown>).result;
    if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
    const sessionId = (result as Record<string, unknown>).sessionId;
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
  } catch {
    return null;
  }
}

// Xcode sends session/set_mode with modes it knows ("standard", "plan") that the
// backend may not expose. Rewrite an unknown modeId to the backend's default mode
// (the mode config option's currentValue from session/new) so the request succeeds
// instead of failing with "mode not found". Known modes pass through unchanged.
function rewriteUnknownSetMode(line: string, availableModes: string[], defaultMode: string | null): string {
  if (availableModes.length === 0 || defaultMode === null) return line;
  try {
    const msg = JSON.parse(line) as { method?: unknown; params?: { modeId?: unknown } };
    if (msg.method !== "session/set_mode") return line;
    const modeId = msg.params?.modeId;
    if (typeof modeId !== "string" || availableModes.includes(modeId)) return line;
    return JSON.stringify({ ...msg, params: { ...msg.params, modeId: defaultMode } });
  } catch {
    return line;
  }
}

const SESSION_ID_METHODS = new Set(["session/new", "session/resume", "session/load"]);

function sessionIdFromRequestRaw(method: string | null, line: string): string | null {
  if (method === null || !SESSION_ID_METHODS.has(method)) return null;
  try {
    const msg: unknown = JSON.parse(line);
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return null;
    const params = (msg as Record<string, unknown>).params;
    if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
    const sessionId = (params as Record<string, unknown>).sessionId;
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
  } catch {
    return null;
  }
}

function isNodeReadable(
  stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
): stream is NodeJS.ReadableStream {
  return typeof (stream as NodeJS.ReadableStream).on === "function";
}

async function readNodeStdin(
  stream: NodeJS.ReadableStream,
  splitter: ReturnType<typeof splitLines>,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      void splitter.flush().then(resolve);
    };
    stream.on("data", (chunk: Buffer | string) => {
      splitter.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    stream.on("end", done);
    stream.on("close", done);
    stream.on("destroy", done);
    stream.on("error", done);
    stream.resume?.();
  });
}

async function readWebStdin(
  stream: ReadableStream<Uint8Array>,
  splitter: ReturnType<typeof splitLines>,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    splitter.push(decoder.decode(value, { stream: true }));
  }
  await splitter.flush();
}

async function pumpBackendStdout(
  stdout: ReadableStream<Uint8Array>,
  splitter: ReturnType<typeof splitLines>,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stdout.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    splitter.push(decoder.decode(value, { stream: true }));
  }
  await splitter.flush();
}

function pumpBackendStderr(stderr: ReadableStream<Uint8Array>): void {
  void (async () => {
    const decoder = new TextDecoder();
    const reader = stderr.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      if (text.length > 0) console.error(text);
    }
  })();
}

export async function runBridge(opts: RunBridgeOptions): Promise<{ code: number }> {
  const store = new AcpEventStore(opts.eventsPath);
  const bridgePid = opts.bridgePid ?? process.pid;
  let seq = 0;
  let backendPid: number | null = null;
  let finished = false;
  const pendingModel = opts.pendingModel ?? null;
  const injectPendingOnNew = shouldInjectPendingModelOnNew(opts.modelApply);
  const sessionNewIds = new Set<string | number>();
  const injectedIds = new Set<string>();
  const injectedSessions = new Set<string>();
  let injectSeq = 0;

  const makeEvent = (partial: Partial<AcpEvent> & Pick<AcpEvent, "kind">): AcpEvent => ({
    id: `${bridgePid}-${++seq}`,
    ts: new Date().toISOString(),
    bridgePid,
    backendPid,
    dir: null,
    rpcId: null,
    method: null,
    sessionHints: [],
    raw: "",
    truncated: false,
    parseError: null,
    route: opts.route ?? null,
    cwd: null,
    mcpXcodeSessionId: null,
    sessionUpdate: null,
    toolName: null,
    modelCurrent: null,
    modelCount: null,
    ...partial,
  });

  const appendProcessEnd = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    await store.append(
      makeEvent({
        kind: "process_end",
        raw: "",
      }),
    );
  };

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([opts.backendCommand, ...opts.backendArgs], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    backendPid = proc.pid;
    await store.append(
      makeEvent({
        kind: "process_start",
        raw: JSON.stringify({
          route: opts.route ?? null,
          command: opts.backendCommand,
          args: opts.backendArgs,
        }),
        route: opts.route ?? null,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.append(
      makeEvent({
        kind: "process_start_error",
        raw: message,
        parseError: message,
        route: opts.route ?? null,
      }),
    );
    return { code: 1 };
  }

  pumpBackendStderr(proc.stderr);

  const startedAtMs = Date.now();
  const commandsDir = opts.commandsDir ?? commandsDirFor(opts.eventsPath);
  const commandFileName = `${bridgePid}.json`;
  const commandFilePath = path.join(commandsDir, commandFileName);
  let commandsDirReady = true;
  try {
    fs.mkdirSync(commandsDir, { recursive: true });
  } catch {
    // Live model switch is unavailable for this run; forwarding continues unaffected.
    commandsDirReady = false;
  }

  let lastSessionId: string | null = null;
  let appliedModel: string | null = pendingModel;
  let desiredLiveModel: string | null = null;
  let availableModes: string[] = [];
  let defaultMode: string | null = null;
  let lastCommandMtime = 0;
  let lastConsumedCommandTs: number | null = null;
  let pendingLiveApply = false;
  let liveInjectSeq = 0;
  let watcher: fs.FSWatcher | null = null;

  const logRpc = async (dir: AcpDir, line: string) => {
    const parsed = parseRpcLine(line, opts.maxRawBytes);
    await store.append(
      makeEvent({
        kind: "rpc",
        dir,
        rpcId: parsed.rpcId,
        method: parsed.method,
        sessionHints: parsed.sessionHints,
        raw: parsed.raw,
        truncated: parsed.truncated,
        parseError: parsed.parseError,
        cwd: parsed.cwd,
        mcpXcodeSessionId: parsed.mcpXcodeSessionId,
        sessionUpdate: parsed.sessionUpdate,
        toolName: parsed.toolName,
        modelCurrent: parsed.modelCurrent,
        modelCount: parsed.modelCount,
      }),
    );
    return parsed;
  };

  const maybeApplyLiveModel = async (): Promise<void> => {
    if (lastSessionId === null) return;
    if (desiredLiveModel === null) return;
    if (!pendingLiveApply && desiredLiveModel === appliedModel) return;
    pendingLiveApply = false;
    const injectId = `bridge-live-${++liveInjectSeq}`;
    injectedIds.add(injectId);
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: injectId,
      method: "session/set_config_option",
      params: {
        sessionId: lastSessionId,
        configId: "model",
        type: "select",
        value: desiredLiveModel,
      },
    });
    appliedModel = desiredLiveModel;
    await logRpc("c2a", request);
    try {
      proc.stdin.write(`${request}\n`);
    } catch {
      // backend stdin already closed
    }
  };

  const seedStoredSessionModel = (sessionId: string): void => {
    if (desiredLiveModel !== null) return;
    const stored = lookupSessionModel(opts.eventsPath, sessionId);
    if (stored === null) return;
    desiredLiveModel = stored;
    pendingLiveApply = true;
  };

  const pollCommandFile = async (): Promise<void> => {
    let mtime = 0;
    try {
      mtime = fs.statSync(commandFilePath).mtimeMs;
    } catch {
      return;
    }
    if (mtime === lastCommandMtime) return;
    lastCommandMtime = mtime;
    const cmd = readModelCommand(commandFilePath);
    if (!cmd || cmd.ts < startedAtMs) return;
    // A command file rewritten with a newer ts is retry intent even when the
    // model string is unchanged (the user re-picked the same option to retry
    // a failed apply). Only a genuinely-unread ts bypasses the same-model
    // short-circuit in maybeApplyLiveModel below.
    if (cmd.ts === lastConsumedCommandTs) return;
    lastConsumedCommandTs = cmd.ts;
    desiredLiveModel = cmd.model;
    pendingLiveApply = true;
    await maybeApplyLiveModel();
  };

  let pollChain = Promise.resolve();
  const schedulePoll = (): void => {
    pollChain = pollChain.catch(() => {}).then(pollCommandFile);
  };

  if (commandsDirReady) {
    try {
      watcher = fs.watch(commandsDir, (_event, filename) => {
        if (filename != null && filename !== commandFileName) return;
        schedulePoll();
      });
    } catch {
      // c2a stat fallback remains
    }
  }

  const c2aSplitter = splitLines(async (line) => {
    const forwarded = rewriteUnknownSetMode(line, availableModes, defaultMode);
    const parsed = await logRpc("c2a", forwarded);
    const fromRequest = sessionIdFromRequestRaw(parsed.method, forwarded);
    if (fromRequest) {
      lastSessionId = fromRequest;
      seedStoredSessionModel(fromRequest);
    }
    if (
      injectPendingOnNew &&
      pendingModel !== null &&
      parsed.method === "session/new" &&
      parsed.rpcId !== null
    ) {
      sessionNewIds.add(parsed.rpcId);
    }
    await pollCommandFile();
    if (
      parsed.method !== "session/new" &&
      parsed.method !== "session/resume" &&
      parsed.method !== "session/load"
    ) {
      await maybeApplyLiveModel();
    }
    proc.stdin.write(`${forwarded}\n`);
  });

  const a2cSplitter = splitLines(async (line) => {
    const parsed = await logRpc("a2c", line);
    if (parsed.modeOptions.length > 0) availableModes = parsed.modeOptions;
    if (parsed.modeCurrent !== null) defaultMode = parsed.modeCurrent;
    if (parsed.rpcId !== null && injectedIds.has(String(parsed.rpcId))) {
      return; // response to a bridge-injected request: logged, never forwarded
    }

    // Cursor extension RPCs (create_plan / update_todos / …): Xcode does not
    // implement them. Translate + auto-ack so the agent turn can finish.
    const cursorShim = handleCursorExtensionLine(line, lastSessionId);
    if (cursorShim) {
      for (const note of cursorShim.clientNotifications) {
        await logRpc("a2c", note);
        opts.stdout.write(`${note}\n`);
      }
      for (const reply of cursorShim.agentReplies) {
        await logRpc("c2a", reply);
        try {
          proc.stdin.write(`${reply}\n`);
        } catch {
          // backend stdin already closed
        }
      }
      if (cursorShim.suppressOriginal) return;
    }

    // Qoder extension RPCs are not part of standard ACP and Xcode does not
    // implement them. Suppress them and acknowledge requests to prevent hangs.
    const qoderShim = handleQoderExtensionLine(line, lastSessionId);
    if (qoderShim) {
      for (const note of qoderShim.clientNotifications) {
        await logRpc("a2c", note);
        opts.stdout.write(`${note}\n`);
      }
      for (const reply of qoderShim.agentReplies) {
        await logRpc("c2a", reply);
        try {
          proc.stdin.write(`${reply}\n`);
        } catch {
          // backend stdin already closed
        }
      }
      if (qoderShim.suppressOriginal) return;
    }

    opts.stdout.write(`${line}\n`);
    const fromNew = sessionIdFromNewResultRaw(line);
    if (fromNew) {
      lastSessionId = fromNew;
      seedStoredSessionModel(fromNew);
    }
    if (pendingModel !== null && parsed.rpcId !== null && sessionNewIds.has(parsed.rpcId)) {
      sessionNewIds.delete(parsed.rpcId);
      const sessionId = fromNew;
      if (sessionId !== null && !injectedSessions.has(sessionId)) {
        injectedSessions.add(sessionId);
        const injectId = `bridge-${++injectSeq}`;
        injectedIds.add(injectId);
        const request = JSON.stringify({
          jsonrpc: "2.0",
          id: injectId,
          method: "session/set_config_option",
          params: { sessionId, configId: "model", type: "select", value: pendingModel },
        });
        await logRpc("c2a", request);
        proc.stdin.write(`${request}\n`);
      }
    }
    await maybeApplyLiveModel();
  });

  const backendOutDone = pumpBackendStdout(proc.stdout, a2cSplitter);

  const stdinDone = isNodeReadable(opts.stdin)
    ? readNodeStdin(opts.stdin, c2aSplitter)
    : readWebStdin(opts.stdin, c2aSplitter);

  let killedByStdin = false;
  const stdinClosed = stdinDone.then(async () => {
    killedByStdin = true;
    try {
      proc.stdin.end();
    } catch {
      // already closed
    }
    const killer = setTimeout(() => {
      proc.kill();
    }, 2000);
    await proc.exited;
    clearTimeout(killer);
  });

  try {
    await Promise.race([stdinClosed, proc.exited]);
    const code = await proc.exited;
    await appendProcessEnd();
    if (typeof opts.stdout.end === "function") {
      opts.stdout.end();
    }
    await backendOutDone;
    return { code: killedByStdin ? 0 : (code ?? 1) };
  } finally {
    watcher?.close();
    await pollChain.catch(() => {
      // in-flight poll/apply is swallowed on shutdown
    });
    try {
      fs.unlinkSync(commandFilePath);
    } catch {
      // leftover is ignored next spawn via ts < startedAtMs
    }
  }
}
