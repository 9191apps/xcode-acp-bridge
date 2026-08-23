import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAcpPathLayout } from "../src/acp/paths";

describe("resolveAcpPathLayout", () => {
  test("env ACP_BRIDGE_HOME + CONFIG + RESOURCES wins", () => {
    const layout = resolveAcpPathLayout({
      env: {
        ACP_BRIDGE_HOME: "/tmp/acp-home",
        ACP_BRIDGE_CONFIG: "/tmp/acp-home/acp-bridge.config.json",
        ACP_BRIDGE_RESOURCES: "/tmp/acp-res",
      },
      repoFallback: "/repo",
    });
    expect(layout.mode).toBe("env");
    expect(layout.home).toBe("/tmp/acp-home");
    expect(layout.resources).toBe("/tmp/acp-res");
    expect(layout.configPath).toBe("/tmp/acp-home/acp-bridge.config.json");
  });

  test("execPath inside Fake.app/Contents/MacOS → app mode", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-app-"));
    const macOS = path.join(root, "Fake.app", "Contents", "MacOS");
    const resources = path.join(root, "Fake.app", "Contents", "Resources");
    fs.mkdirSync(macOS, { recursive: true });
    fs.mkdirSync(resources, { recursive: true });
    const execPath = path.join(macOS, "acp-bridge");
    fs.writeFileSync(execPath, "");
    const layout = resolveAcpPathLayout({
      execPath,
      env: {},
      repoFallback: "/should-not-use",
    });
    expect(layout.mode).toBe("app");
    expect(layout.resources).toBe(resources);
    expect(layout.home).toBe(path.join(os.homedir(), "Library", "Application Support", "ACP Bridge"));
    expect(layout.configPath).toBe(path.join(layout.home, "acp-bridge.config.json"));
  });

  test("otherwise uses repoFallback", () => {
    const layout = resolveAcpPathLayout({
      execPath: "/usr/bin/bun",
      env: {},
      repoFallback: "/Users/dev/xcode-acp-bridge",
    });
    expect(layout.mode).toBe("repo");
    expect(layout.home).toBe("/Users/dev/xcode-acp-bridge");
    expect(layout.resources).toBe("/Users/dev/xcode-acp-bridge");
    expect(layout.configPath).toBe("/Users/dev/xcode-acp-bridge/acp-bridge.config.json");
  });
});
