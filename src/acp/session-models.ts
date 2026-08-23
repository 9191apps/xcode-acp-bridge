import fs from "node:fs";
import path from "node:path";

export function sessionModelsPathFor(eventsPath: string): string {
  return path.join(path.dirname(eventsPath), "acp-session-models.json");
}

export function loadSessionModels(eventsPath: string): Record<string, string> {
  const filePath = sessionModelsPathFor(eventsPath);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key.length > 0 && typeof value === "string" && value.length > 0) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function lookupSessionModel(eventsPath: string, sessionId: string): string | null {
  return loadSessionModels(eventsPath)[sessionId] ?? null;
}

export function writeSessionModel(eventsPath: string, sessionId: string, model: string): void {
  const filePath = sessionModelsPathFor(eventsPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const next = { ...loadSessionModels(eventsPath), [sessionId]: model };
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`);
  fs.renameSync(tmp, filePath);
}
