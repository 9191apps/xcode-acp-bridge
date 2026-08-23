import fs from "node:fs";
import path from "node:path";

export type AcpModelCommand = { model: string; ts: number };

export function commandsDirFor(eventsPath: string): string {
  return path.join(path.dirname(eventsPath), "acp-commands");
}

export function writeModelCommand(eventsPath: string, bridgePid: number, model: string): void {
  const dir = commandsDirFor(eventsPath);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${bridgePid}.json`);
  const tmp = path.join(dir, `${bridgePid}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const payload: AcpModelCommand = { model, ts: Date.now() };
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, dest);
}

export function readModelCommand(filePath: string): AcpModelCommand | null {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.model !== "string" || rec.model.length === 0) return null;
    if (typeof rec.ts !== "number" || !Number.isFinite(rec.ts)) return null;
    return { model: rec.model, ts: rec.ts };
  } catch {
    return null;
  }
}
