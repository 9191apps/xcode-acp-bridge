export type AcpEventKind = "rpc" | "process_start" | "process_start_error" | "process_end";
export type AcpDir = "c2a" | "a2c";

export type AcpCommand = { command: string; args: string[] };
export type AcpModelApply = "inject" | "spawn-arg";
/** How Terminal resume launches the backend. Default: cli args on `command`. */
export type AcpResumeMode = "args" | "cursor-acp-load" | "qoder-acp-load";
export type AcpBackend = AcpCommand & {
  modelsCommand?: AcpCommand;
  /** How to apply Next-conversation model. Default: inject via session/set_config_option. */
  modelApply?: AcpModelApply;
  /** Terminal resume argv template; `{sessionId}` is substituted. Default: `["-s", "{sessionId}"]`. */
  resumeArgs?: string[];
  /**
   * Terminal resume strategy. `cursor-acp-load` / `qoder-acp-load` spawn a small ACP client that
   * `session/load`s the ACP session (CLI `--resume` only works for non-ACP chats).
   */
  resumeMode?: AcpResumeMode;
};

export type AcpEvent = {
  id: string;
  ts: string;
  kind: AcpEventKind;
  bridgePid: number;
  backendPid: number | null;
  dir: AcpDir | null;
  rpcId: string | number | null;
  method: string | null;
  sessionHints: string[];
  raw: string;
  truncated: boolean;
  parseError: string | null;
  route?: string | null;
  cwd?: string | null;
  mcpXcodeSessionId?: string | null;
  sessionUpdate?: string | null;
  toolName?: string | null;
  modelCurrent?: string | null;
  modelCount?: number | null;
  /** Present on events that aggregate N consecutive chunk updates (agent_*_chunk): */
  chunkCount?: number;
  /** Concatenated text of the aggregated chunks. */
  chunkText?: string;
  /** ts of the last merged chunk (ts itself is the first chunk's ts). */
  chunkLastTs?: string;
};

export type AcpBridgeConfig = {
  routes: Record<string, AcpBackend>;
  defaultRoute: string;
  defaultBackend: AcpBackend;
  eventsPath: string;
  routeStatePath: string;
  maxRawBytes: number;
};
