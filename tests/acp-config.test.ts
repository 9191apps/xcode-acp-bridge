import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAcpBridgeConfig, repoRoot } from "../src/acp/config";

function writeCfg(body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-cfg-"));
  const cfgPath = path.join(dir, "cfg.json");
  fs.writeFileSync(cfgPath, JSON.stringify(body));
  return cfgPath;
}

describe("loadAcpBridgeConfig", () => {
  test("loads routes and resolves paths against repo root", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        routes: { opencode: { command: "/bin/echo", args: ["acp"] } },
        defaultRoute: "opencode",
        eventsPath: "./data/acp-events.jsonl",
        routeStatePath: "./data/acp-route.json",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.defaultRoute).toBe("opencode");
    expect(cfg.routes.opencode.command).toBe("/bin/echo");
    expect(cfg.defaultBackend).toEqual({ command: "/bin/echo", args: ["acp"] });
    expect(cfg.eventsPath).toBe(path.join(repoRoot(), "data/acp-events.jsonl"));
    expect(cfg.routeStatePath).toBe(path.join(repoRoot(), "data/acp-route.json"));
    expect(cfg.maxRawBytes).toBe(99);
  });

  test("defaultBackend-only config becomes routes.default", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        defaultBackend: { command: "/bin/echo", args: ["acp"] },
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.defaultRoute).toBe("default");
    expect(cfg.routes.default.command).toBe("/bin/echo");
    expect(cfg.defaultBackend.command).toBe("/bin/echo");
    expect(cfg.routeStatePath).toBe(path.join(repoRoot(), "data/acp-route.json"));
  });

  test("expands ~ and env vars in command, args, and modelsCommand", () => {
    const home = os.homedir();
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        routes: {
          opencode: {
            command: "~/bin/opencode",
            args: ["acp", "$HOME/tmp", "${OPENCODE_MODEL:-dummy}"],
            modelsCommand: { command: "${HOME}/bin/opencode", args: ["models"] },
          },
        },
        defaultRoute: "opencode",
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.routes.opencode.command).toBe(`${home}/bin/opencode`);
    expect(cfg.routes.opencode.args).toEqual(["acp", `${home}/tmp`, ""]);
    expect(cfg.routes.opencode.modelsCommand).toEqual({
      command: `${home}/bin/opencode`,
      args: ["models"],
    });
  });

  test("does not expand ~ inside a path and expands defaultBackend form", () => {
    const home = os.homedir();
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        defaultBackend: { command: "~/.opencode/bin/opencode", args: ["acp"] },
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.routes.default.command).toBe(`${home}/.opencode/bin/opencode`);
    expect(cfg.defaultBackend.command).toBe(`${home}/.opencode/bin/opencode`);
  });

  test("throws when routes empty and no defaultBackend", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {},
          defaultRoute: "x",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 1,
        }),
      ),
    ).toThrow(/routes/i);
  });

  test("throws when defaultRoute is not a route key", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: { opencode: { command: "/bin/echo", args: ["acp"] } },
          defaultRoute: "missing",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 1,
        }),
      ),
    ).toThrow(/defaultRoute/);
  });

  test("throws naming the route key when a routes entry is not a backend", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {
            opencode: { command: "/bin/echo", args: ["acp"] },
            broken: { command: "/bin/false" },
          },
          defaultRoute: "opencode",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 1,
        }),
      ),
    ).toThrow(/routes\.broken/);
  });

  test("loads optional modelsCommand per route", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        routes: {
          opencode: {
            command: "/bin/echo",
            args: ["acp"],
            modelsCommand: { command: "/bin/echo", args: ["models"] },
          },
        },
        defaultRoute: "opencode",
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.routes.opencode.modelsCommand).toEqual({ command: "/bin/echo", args: ["models"] });
  });

  test("loads optional modelApply and resumeArgs", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        routes: {
          cursor: {
            command: "/bin/echo",
            args: ["acp"],
            modelApply: "spawn-arg",
            resumeArgs: ["--resume", "{sessionId}"],
          },
        },
        defaultRoute: "cursor",
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.routes.cursor.modelApply).toBe("spawn-arg");
    expect(cfg.routes.cursor.resumeArgs).toEqual(["--resume", "{sessionId}"]);
  });

  test("throws naming the route key when modelApply is invalid", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {
            cursor: { command: "/bin/echo", args: ["acp"], modelApply: "spawn" },
          },
          defaultRoute: "cursor",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 99,
        }),
      ),
    ).toThrow(/routes\.cursor/);
  });

  test("throws naming the route key when resumeArgs is invalid", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {
            cursor: { command: "/bin/echo", args: ["acp"], resumeArgs: "--resume" },
          },
          defaultRoute: "cursor",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 99,
        }),
      ),
    ).toThrow(/routes\.cursor/);
  });

  test("throws naming the route key when modelsCommand is invalid", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {
            opencode: { command: "/bin/echo", args: ["acp"], modelsCommand: { command: "/bin/echo" } },
          },
          defaultRoute: "opencode",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 99,
        }),
      ),
    ).toThrow(/routes\.opencode/);
  });

  test("throws when maxRawBytes is missing", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: { opencode: { command: "/bin/echo", args: ["acp"] } },
          defaultRoute: "opencode",
          eventsPath: "./data/acp-events.jsonl",
        }),
      ),
    ).toThrow(/maxRawBytes/);
  });

  test("throws when maxRawBytes is not a positive number", () => {
    const body = {
      routes: { opencode: { command: "/bin/echo", args: ["acp"] } },
      defaultRoute: "opencode",
      eventsPath: "./data/acp-events.jsonl",
    };
    expect(() => loadAcpBridgeConfig(writeCfg({ ...body, maxRawBytes: 0 }))).toThrow(/maxRawBytes/);
    expect(() => loadAcpBridgeConfig(writeCfg({ ...body, maxRawBytes: -1 }))).toThrow(/maxRawBytes/);
    expect(() => loadAcpBridgeConfig(writeCfg({ ...body, maxRawBytes: "2097152" }))).toThrow(/maxRawBytes/);
  });

  test("loads resumeMode qoder-acp-load", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        routes: {
          qodercli: {
            command: "/bin/echo",
            args: ["--acp"],
            modelApply: "spawn-arg",
            resumeMode: "qoder-acp-load",
          },
        },
        defaultRoute: "qodercli",
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.routes.qodercli.resumeMode).toBe("qoder-acp-load");
    expect(cfg.routes.qodercli.modelApply).toBe("spawn-arg");
  });

  test("throws naming the route key when resumeMode is invalid", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {
            qodercli: { command: "/bin/echo", args: ["--acp"], resumeMode: "cli-r" },
          },
          defaultRoute: "qodercli",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 99,
        }),
      ),
    ).toThrow(/routes\.qodercli/);
  });
});
