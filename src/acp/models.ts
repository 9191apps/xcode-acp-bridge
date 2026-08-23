import type { AcpCommand, AcpEvent } from "./types";

const ID_DASH_LABEL = /^(\S+)\s+-\s+/;

/**
 * Parse models CLI stdout: Cursor `id - Label`, OpenCode one-id-per-line,
 * skip Qoder `MODEL` header and Cursor Tip footers.
 */
export function parseModelsOutput(stdout: string): string[] {
  const ids: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (/^available models$/i.test(line)) continue;
    if (/^model$/i.test(line)) continue;
    if (/^tip:/i.test(line)) continue;
    const match = ID_DASH_LABEL.exec(line);
    if (match) {
      ids.push(match[1]!);
      continue;
    }
    // OpenCode / Qoder: one id per line. Skip prose that failed the Tip prefix check.
    if (/\s/.test(line)) continue;
    ids.push(line);
  }
  return ids;
}

export async function runModelsCommand(cmd: AcpCommand, timeoutMs = 5000): Promise<string[]> {
  const proc = Bun.spawn([cmd.command, ...cmd.args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) throw new Error(`exit ${code}`);
    return parseModelsOutput(out);
  } finally {
    clearTimeout(timer);
  }
}

function modelsFromConfigOptionsRaw(raw: string): string[] | null {
  try {
    const msg: unknown = JSON.parse(raw);
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return null;
    const result = (msg as Record<string, unknown>).result;
    if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
    const options = (result as Record<string, unknown>).configOptions;
    if (!Array.isArray(options)) return null;
    const modelOption = options.find((o) => {
      if (o === null || typeof o !== "object" || Array.isArray(o)) return false;
      const rec = o as Record<string, unknown>;
      return rec.category === "model" || (rec.category == null && rec.id === "model");
    }) as Record<string, unknown> | undefined;
    if (!modelOption || !Array.isArray(modelOption.options)) return null;
    return modelOption.options
      .map((o) =>
        o !== null && typeof o === "object" && typeof (o as Record<string, unknown>).value === "string"
          ? ((o as Record<string, unknown>).value as string)
          : null,
      )
      .filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return null;
  }
}

export function observedModelsFromEvents(events: AcpEvent[], route: string): string[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind !== "rpc" || event.dir !== "a2c" || event.raw.length === 0) continue;
    if (event.route != null && event.route !== route) continue;
    const models = modelsFromConfigOptionsRaw(event.raw);
    if (models !== null && models.length > 0) return models;
  }
  return [];
}
