import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { commandsDirFor, readModelCommand, writeModelCommand } from "../src/acp/commands";

const dir = path.join(import.meta.dir, ".tmp-acp-commands");
const eventsPath = path.join(dir, "acp-events.jsonl");

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("commandsDirFor", () => {
  test("places acp-commands next to the events file", () => {
    expect(commandsDirFor(eventsPath)).toBe(path.join(dir, "acp-commands"));
  });
});

describe("writeModelCommand / readModelCommand", () => {
  test("roundtrip writes {model, ts} atomically (no leftover tmp)", () => {
    writeModelCommand(eventsPath, 42, "fixture/model-b");
    const dest = path.join(commandsDirFor(eventsPath), "42.json");
    const parsed = readModelCommand(dest);
    expect(parsed).not.toBeNull();
    expect(parsed!.model).toBe("fixture/model-b");
    expect(typeof parsed!.ts).toBe("number");
    expect(parsed!.ts).toBeGreaterThan(0);
    const names = fs.readdirSync(commandsDirFor(eventsPath));
    expect(names).toEqual(["42.json"]);
  });

  test("returns null for missing file, invalid JSON, and bad shape", () => {
    expect(readModelCommand(path.join(dir, "missing.json"))).toBeNull();
    fs.mkdirSync(dir, { recursive: true });
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not-json");
    expect(readModelCommand(bad)).toBeNull();
    fs.writeFileSync(bad, JSON.stringify({ model: "", ts: Date.now() }));
    expect(readModelCommand(bad)).toBeNull();
    fs.writeFileSync(bad, JSON.stringify({ model: "x", ts: "nope" }));
    expect(readModelCommand(bad)).toBeNull();
  });
});
