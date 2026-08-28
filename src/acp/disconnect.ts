export type DisconnectResult =
  | { ok: true; bridgePid: number }
  | { ok: false; status: 409 | 500; error: string };

export type DisconnectDeps = {
  alive?: (pid: number) => boolean;
  argsFor?: (pid: number) => string | null;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
};

/** Packaged `…/MacOS/acp-bridge` or `bun …/acp-bridge.ts` — not serve/resume helpers. */
export function looksLikeAcpBridge(args: string): boolean {
  const s = args.trim();
  if (!s) return false;
  return /(?:^|\/)acp-bridge(?:\.ts)?(?:\s|$)/.test(s);
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function processArgsForPid(pid: number): string | null {
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-ww", "-o", "args="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  const text = new TextDecoder().decode(result.stdout).trim();
  return text.length > 0 ? text : null;
}

/**
 * SIGTERM a live `acp-bridge` so Xcode drops the ACP stdio session.
 * Never signals acp-serve or an unrelated pid.
 */
export function disconnectAcpBridge(pid: number, deps: DisconnectDeps = {}): DisconnectResult {
  const alive = deps.alive ?? processAlive;
  const argsFor = deps.argsFor ?? processArgsForPid;
  const signal = deps.signal ?? ((target, sig) => process.kill(target, sig));
  if (!alive(pid)) return { ok: false, status: 409, error: "not live" };
  const args = argsFor(pid) ?? "";
  if (!looksLikeAcpBridge(args)) {
    return { ok: false, status: 409, error: "not an acp-bridge process" };
  }
  try {
    signal(pid, "SIGTERM");
  } catch (err) {
    const code =
      err !== null && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === "ESRCH") return { ok: true, bridgePid: pid };
    return { ok: false, status: 500, error: "signal failed" };
  }
  return { ok: true, bridgePid: pid };
}
