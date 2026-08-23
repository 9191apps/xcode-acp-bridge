import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  loadSessionModels,
  lookupSessionModel,
  sessionModelsPathFor,
  writeSessionModel,
} from "../src/acp/session-models";

const dir = path.join(import.meta.dir, ".tmp-acp-session-models");
const eventsPath = path.join(dir, "acp-events.jsonl");

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("sessionModelsPathFor", () => {
  test("places acp-session-models.json next to the events file", () => {
    expect(sessionModelsPathFor(eventsPath)).toBe(path.join(dir, "acp-session-models.json"));
  });
});

describe("writeSessionModel / lookupSessionModel", () => {
  test("roundtrip stores model keyed by session id", () => {
    writeSessionModel(eventsPath, "sess-aaa", "fixture/model-b");
    expect(lookupSessionModel(eventsPath, "sess-aaa")).toBe("fixture/model-b");
    expect(loadSessionModels(eventsPath)).toEqual({ "sess-aaa": "fixture/model-b" });
  });

  test("merges additional sessions without dropping earlier ones", () => {
    writeSessionModel(eventsPath, "sess-aaa", "fixture/model-a");
    writeSessionModel(eventsPath, "sess-bbb", "fixture/model-b");
    writeSessionModel(eventsPath, "sess-aaa", "fixture/model-c");
    expect(loadSessionModels(eventsPath)).toEqual({
      "sess-aaa": "fixture/model-c",
      "sess-bbb": "fixture/model-b",
    });
  });

  test("returns empty/null for missing file or unknown session", () => {
    expect(loadSessionModels(eventsPath)).toEqual({});
    expect(lookupSessionModel(eventsPath, "sess-aaa")).toBeNull();
  });
});
