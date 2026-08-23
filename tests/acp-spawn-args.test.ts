import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBackendSpawnArgs, shouldInjectPendingModelOnNew } from "../src/acp/spawn-args";
import { repoRoot } from "../src/acp/config";
import {
  buildResumeLaunchArgs,
  expandResumeArgs,
  DEFAULT_RESUME_ARGS,
  cursorAcpResumeScriptPath,
  qoderAcpResumeScriptPath,
} from "../src/dashboard/acp-routes";

describe("resolveBackendSpawnArgs", () => {
  test("inject (default) leaves args unchanged", () => {
    expect(resolveBackendSpawnArgs({ args: ["acp"] }, "m1")).toEqual(["acp"]);
    expect(resolveBackendSpawnArgs({ args: ["acp"], modelApply: "inject" }, "m1")).toEqual(["acp"]);
  });

  test("spawn-arg appends --model when pending", () => {
    expect(resolveBackendSpawnArgs({ args: ["acp"], modelApply: "spawn-arg" }, "composer-2.5")).toEqual([
      "acp",
      "--model",
      "composer-2.5",
    ]);
  });

  test("spawn-arg without pending leaves args unchanged", () => {
    expect(resolveBackendSpawnArgs({ args: ["acp"], modelApply: "spawn-arg" }, null)).toEqual(["acp"]);
    expect(resolveBackendSpawnArgs({ args: ["acp"], modelApply: "spawn-arg" }, "")).toEqual(["acp"]);
  });
});

describe("shouldInjectPendingModelOnNew", () => {
  test("inject for default and inject; skip for spawn-arg", () => {
    expect(shouldInjectPendingModelOnNew(undefined)).toBe(true);
    expect(shouldInjectPendingModelOnNew("inject")).toBe(true);
    expect(shouldInjectPendingModelOnNew("spawn-arg")).toBe(false);
  });
});

describe("expandResumeArgs", () => {
  test("substitutes sessionId placeholder", () => {
    expect(expandResumeArgs(DEFAULT_RESUME_ARGS, "ses_1")).toEqual(["-s", "ses_1"]);
    expect(expandResumeArgs(["--resume", "{sessionId}"], "ses_1")).toEqual(["--resume", "ses_1"]);
  });
});

describe("buildResumeLaunchArgs", () => {
  test("args mode uses backend command and resumeArgs", () => {
    expect(
      buildResumeLaunchArgs(
        { command: "/bin/opencode", resumeArgs: ["-s", "{sessionId}"] },
        "ses_1",
        "/tmp/proj",
      ),
    ).toEqual({ bin: "/bin/opencode", argv: ["-s", "ses_1"] });
  });

  test("cursor-acp-load mode launches bun helper with agent + session", () => {
    const launched = buildResumeLaunchArgs(
      {
        command: "/Users/me/.local/bin/agent",
        resumeMode: "cursor-acp-load",
        resumeArgs: ["--resume", "{sessionId}"],
      },
      "bd4d53b5-57ce-4ebd-a48d-c7b2b7e9d426",
      "/Users/me/proj",
    );
    expect(launched.bin).toBe(process.execPath);
    expect(launched.argv).toEqual([
      cursorAcpResumeScriptPath(),
      "--agent",
      "/Users/me/.local/bin/agent",
      "--session-id",
      "bd4d53b5-57ce-4ebd-a48d-c7b2b7e9d426",
      "--cwd",
      "/Users/me/proj",
    ]);
    expect(launched.argv[0]).toBe(path.join(repoRoot(), "src", "acp", "cursor-acp-resume.ts"));
  });

  test("qoder-acp-load mode launches bun qoder helper with agent + session", () => {
    const launched = buildResumeLaunchArgs(
      {
        command: "/Users/me/.local/bin/qodercli",
        resumeMode: "qoder-acp-load",
      },
      "sess-qoder-1",
      "/Users/me/proj",
    );
    expect(launched.bin).toBe(process.execPath);
    expect(launched.argv).toEqual([
      qoderAcpResumeScriptPath(),
      "--agent",
      "/Users/me/.local/bin/qodercli",
      "--session-id",
      "sess-qoder-1",
      "--cwd",
      "/Users/me/proj",
    ]);
    expect(launched.argv[0]).toBe(path.join(repoRoot(), "src", "acp", "qoder-acp-resume.ts"));
  });

  test("packaged cursor helper launches directly from resources/bin", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-resume-"));
    const contents = path.join(root, "ACP Bridge.app", "Contents");
    const execPath = path.join(contents, "MacOS", "ACP Bridge");
    const helper = path.join(contents, "Resources", "bin", "cursor-acp-resume");
    const alternateHelper = path.join(contents, "MacOS", "cursor-acp-resume");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, "#!/bin/sh\n");
    fs.chmodSync(helper, 0o755);
    fs.mkdirSync(path.dirname(alternateHelper), { recursive: true });
    fs.writeFileSync(alternateHelper, "#!/bin/sh\n");
    fs.chmodSync(alternateHelper, 0o755);

    try {
      expect(
        buildResumeLaunchArgs(
          { command: "/usr/local/bin/agent", resumeMode: "cursor-acp-load" },
          "session-1",
          "/tmp/project",
          { execPath, env: {} },
        ),
      ).toEqual({
        bin: helper,
        argv: [
          "--agent",
          "/usr/local/bin/agent",
          "--session-id",
          "session-1",
          "--cwd",
          "/tmp/project",
        ],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("app layout falls back to executable beside the app launcher", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-resume-"));
    const contents = path.join(root, "ACP Bridge.app", "Contents");
    const execPath = path.join(contents, "MacOS", "ACP Bridge");
    const helper = path.join(contents, "MacOS", "qoder-acp-resume");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, "#!/bin/sh\n");
    fs.chmodSync(helper, 0o755);

    try {
      expect(
        buildResumeLaunchArgs(
          { command: "/usr/local/bin/qodercli", resumeMode: "qoder-acp-load" },
          "session-2",
          null,
          { execPath, env: {} },
        ),
      ).toEqual({
        bin: helper,
        argv: [
          "--agent",
          "/usr/local/bin/qodercli",
          "--session-id",
          "session-2",
        ],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
